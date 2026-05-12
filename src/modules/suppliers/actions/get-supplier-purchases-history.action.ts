import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { findSupplierInCompany } from '../internal/supplier-lookups';

/**
 * Shape de respuesta del endpoint `GET /suppliers/:id/purchases-history`.
 *
 * En PlacePos NO existe este endpoint todavía (no se implementó en el
 * servidor Express local). Lo incluimos en este API porque el prompt de
 * Fase 4 lo solicita explícitamente y el frontend cloud podría consumirlo en
 * el futuro. Mantiene el patrón simétrico con `customers/sales-history`.
 *
 * En Fase 4 las entidades `Purchase` / `PurchaseLine` AÚN no existen. Por eso
 * devolvemos `purchases: []` y `summary` cero.
 *
 * TODO(Fase 8): reemplazar con consulta a `purchases` (filtrando supplier_id
 * + company_id + is_deleted = false). Sin el filtro `company_id`, fuga
 * cross-tenant garantizada.
 */
export interface SupplierPurchasesHistoryResponse {
  purchases: unknown[];
  summary: {
    purchasesCount: number;
    totalAmount: number;
    totalPaid: number;
    totalPending: number;
  };
}

@Injectable()
export class GetSupplierPurchasesHistoryAction {
  constructor(
    @InjectRepository(Supplier)
    private readonly repo: Repository<Supplier>,
  ) {}

  async execute(id: number, companyId: number): Promise<SupplierPurchasesHistoryResponse> {
    // Pre-validar tenancy. Sin este check, un id de otra company devolvería
    // un objeto vacío indistinguible de un supplier real sin compras —
    // fuga sutil de existencia cross-tenant.
    await findSupplierInCompany(this.repo.manager, id, companyId);

    return {
      purchases: [],
      summary: {
        purchasesCount: 0,
        totalAmount: 0,
        totalPaid: 0,
        totalPending: 0,
      },
    };
  }
}
