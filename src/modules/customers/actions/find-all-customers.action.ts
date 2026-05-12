import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type Repository } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

import type { ListCustomersQueryDto } from '../dto/list-customers-query.dto';

/**
 * Lista customers de una company, ordenados por `created_at DESC`.
 *
 * Paridad PlacePos: el endpoint local `GET /customers` no filtra ni pagina.
 * Aquí ofrecemos las extensiones opt-in `search`, `include_archived`,
 * `limit`, `offset` — todas tolerantes a omisión (el cliente Electron las
 * ignora y recibe el mismo array de siempre).
 *
 * Read puro — no requiere transacción. El filtrado por `company_id` es
 * obligatorio: TODA query del módulo lo aplica.
 */
@Injectable()
export class FindAllCustomersAction {
  constructor(
    @InjectRepository(Customer)
    private readonly repo: Repository<Customer>,
  ) {}

  async execute(companyId: number, query: ListCustomersQueryDto = {}): Promise<Customer[]> {
    const qb = this.repo
      .createQueryBuilder('c')
      .where('c.company_id = :companyId', { companyId: String(companyId) });

    // include_archived llega como string ("true" o "false") porque viene del
    // query string. Default: ocultar archivados (paridad con el filtro
    // típico de PlacePos).
    if (query.include_archived !== 'true') {
      qb.andWhere('c.is_archived = false');
    }

    if (query.search && query.search.trim().length > 0) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      // Búsqueda case-insensitive en name, doc_number, phone. Usamos
      // `lower(name)` para aprovechar `idx_customers_company_name_lower`.
      // `doc_number` y `phone` no tienen índice trgm; el filtro es scan,
      // aceptable para listas chicas; si el volumen crece se evalúa pg_trgm.
      qb.andWhere('(lower(c.name) LIKE :term OR c.doc_number ILIKE :term OR c.phone ILIKE :term)', {
        term,
      });
    }

    qb.orderBy('c.created_at', 'DESC');

    if (typeof query.limit === 'number') {
      qb.limit(query.limit);
    }
    if (typeof query.offset === 'number') {
      qb.offset(query.offset);
    }

    return qb.getMany();
  }
}
