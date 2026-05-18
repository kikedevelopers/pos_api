import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager, Repository } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { findPackagingInCompany } from '../internal/packaging-lookups';

/**
 * `GET /packagings/:id/products` — Lista productos asociados a un packaging.
 * Espejo PlacePos `packagings.routes.ts` § 29.
 *
 * Reglas:
 *   - 404 si el packaging no existe en la company (anti-enumeración cross-tenant).
 *   - Incluye relations `parent` (presentación → producto padre). `category`
 *     no existe aún en pos_api (Fase 3), por lo que no se incluye en este
 *     endpoint hasta que la entidad se añada.
 *   - Filtra `is_archived = false` — solo productos activos.
 *
 * Multi-tenant: filtros `company_id` doble (Packaging + Product) para
 * defensa en profundidad — un producto NUNCA debe ser visible si su
 * packaging es de otra company (estado imposible pero protección extra).
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class ListProductsByPackagingAction {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
  ) {}

  async execute(packagingId: number, companyId: number): Promise<Product[]> {
    // El lookup usa el manager del propio repo para evitar acoplamiento
    // con DataSource. NotFoundException si el packaging no es de la company.
    const manager: EntityManager = this.productRepo.manager;
    await findPackagingInCompany(manager, packagingId, companyId, { includeArchived: true });

    return this.productRepo.find({
      where: {
        company_id: String(companyId),
        packaging_id: String(packagingId),
        is_archived: false,
      },
      relations: { parent: true, packaging: true },
      order: { created_at: 'DESC' },
    });
  }
}
