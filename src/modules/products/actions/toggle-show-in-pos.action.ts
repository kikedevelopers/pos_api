import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Product } from '../entities/product.entity';
import { findProductInCompany } from '../internal/product-lookups';

/**
 * Toggle `show_in_pos` para un producto. Endpoint
 * `PUT /inventory/:id/show-in-pos`.
 *
 * Divergencia controlada vs PlacePos: PlacePos sólo expone la versión
 * bulk (`PUT /inventory/show-in-pos` con `{ ids, show_in_pos }`). Aquí
 * añadimos la versión individual por id (más RESTful). El bulk también
 * se expone con su propia action.
 *
 * Transacción: §8.8 del CLAUDE.md. Pre-validar existencia + UPDATE.
 */
@Injectable()
export class ToggleShowInPosAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, showInPos: boolean, companyId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await findProductInCompany(manager, id, companyId);

      await manager.update(
        Product,
        { id: String(id), company_id: String(companyId) },
        { show_in_pos: showInPos },
      );
    });
  }
}
