import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { Purchase } from '../entities/purchase.entity';

/**
 * Lista compras de un supplier dentro de la company.
 *
 * Espejo PlacePos `GET /purchases/by-supplier/:supplierId`:
 *   - Filtra `is_deleted = false`.
 *   - Orden `created_at DESC`.
 *
 * Anti-IDOR cross-tenant: pre-valida que el `supplier_id` exista en la
 * company. Sin ese check, un id de otra company devolvería `[]` y el atacante
 * podría enumerar la existencia (timing/diff). Devolvemos 404 explícito.
 *
 * Costo: cubierto por `idx_purchases_company_supplier_created`.
 */
@Injectable()
export class FindPurchasesBySupplierAction {
  constructor(
    @InjectRepository(Purchase)
    private readonly purchaseRepo: Repository<Purchase>,
    @InjectRepository(Supplier)
    private readonly supplierRepo: Repository<Supplier>,
  ) {}

  async execute(supplierId: number, companyId: number): Promise<Purchase[]> {
    const supplier = await this.supplierRepo.findOne({
      where: { id: String(supplierId), company_id: String(companyId) },
      select: { id: true },
    });
    if (!supplier) {
      throw new NotFoundException('Proveedor no encontrado');
    }

    return this.purchaseRepo.find({
      where: {
        supplier_id: String(supplierId),
        company_id: String(companyId),
        is_deleted: false,
      },
      order: { created_at: 'DESC' },
    });
  }
}
