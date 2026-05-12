import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Product } from '../entities/product.entity';
import { findProductInCompany } from '../internal/product-lookups';

/**
 * Archiva un producto (soft-delete). Endpoint `PUT /inventory/:id/archive`.
 *
 *   - 404 si no existe o pertenece a otra company.
 *   - Idempotente: archivar uno ya archivado devuelve 200 con
 *     `{ archived: true }` (sin re-escribir).
 *
 * No cascada a hijos: si el producto tiene combos, el service decide
 * en el futuro (Fase 5+) si propagar. Por ahora archivamos solo el padre
 * y dejamos los hijos visibles — espejo PlacePos.
 */
@Injectable()
export class ArchiveProductAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const product = await findProductInCompany(manager, id, companyId);

      if (product.is_archived) {
        return; // idempotente
      }

      await manager.update(
        Product,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });
  }
}
