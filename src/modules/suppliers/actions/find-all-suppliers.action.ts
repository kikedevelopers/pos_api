import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import type { ListSuppliersQueryDto } from '../dto/list-suppliers-query.dto';

/**
 * Lista suppliers de una company, ordenados por `created_at DESC`.
 *
 * Paridad PlacePos: el endpoint local filtra `is_archived = false` por
 * defecto. Espejamos ese default y permitimos `include_archived=true` como
 * opt-in.
 *
 * Búsqueda case-insensitive sobre legal_name, broker, doc_number, phone
 * (extensión cloud — el frontend Electron no envía el parámetro).
 */
@Injectable()
export class FindAllSuppliersAction {
  constructor(
    @InjectRepository(Supplier)
    private readonly repo: Repository<Supplier>,
  ) {}

  async execute(companyId: number, query: ListSuppliersQueryDto = {}): Promise<Supplier[]> {
    const qb = this.repo
      .createQueryBuilder('s')
      .where('s.company_id = :companyId', { companyId: String(companyId) });

    // Default: ocultar archivados — paridad byte-por-byte con PlacePos.
    if (query.include_archived !== 'true') {
      qb.andWhere('s.is_archived = false');
    }

    if (query.search && query.search.trim().length > 0) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      // `legal_name` tiene índice (company_id, lower(legal_name)) — el LIKE
      // sobre lower() lo aprovecha para prefijos. `broker`, `doc_number` y
      // `phone` son scan; aceptable para volúmenes esperados (< 10k filas
      // por company).
      qb.andWhere(
        '(lower(s.legal_name) LIKE :term OR s.broker ILIKE :term OR s.doc_number ILIKE :term OR s.phone ILIKE :term)',
        { term },
      );
    }

    qb.orderBy('s.created_at', 'DESC');

    if (typeof query.limit === 'number') {
      qb.limit(query.limit);
    }
    if (typeof query.offset === 'number') {
      qb.offset(query.offset);
    }

    return qb.getMany();
  }
}
