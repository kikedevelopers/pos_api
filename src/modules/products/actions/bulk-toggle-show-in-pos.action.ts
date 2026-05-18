import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';

import { Product } from '../entities/product.entity';

/**
 * Resultado del bulk toggle de `show_in_pos`. Espejo PlacePos
 * (`{ updated: N, show_in_pos }`), con el añadido de `updated_ids` y
 * `not_found` para transparencia.
 */
export interface BulkToggleShowInPosResult {
  updated_count: number;
  updated_ids: number[];
  not_found: number[];
  show_in_pos: boolean;
}

/**
 * `PUT /inventory/show-in-pos` — Toggle bulk de visibilidad en POS.
 *
 * Espejo de PlacePos `inventory.routes.ts` línea 176-192. Mismo principio
 * multi-tenant que `bulk-archive-products.action.ts`: filtramos por
 * `company_id` para nunca tocar productos de otra company.
 *
 * Comportamiento:
 *   - Solo se actualizan productos cuyo `show_in_pos` actual difiera del
 *     valor solicitado. Esto da `updated_count` honesto en lugar del
 *     `affected` engañoso de PG (que cuenta filas que matchearon el WHERE).
 *   - Ids inexistentes en la company se reportan en `not_found`.
 *
 * Transacción: §8.8 — wrap en transacción para defensa en profundidad.
 */
@Injectable()
export class BulkToggleShowInPosAction {
  private readonly logger = new Logger(BulkToggleShowInPosAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    ids: number[],
    showInPos: boolean,
    companyId: number,
  ): Promise<BulkToggleShowInPosResult> {
    const cleanIds = Array.from(new Set(ids.filter((n) => Number.isInteger(n) && n > 0)));
    if (cleanIds.length === 0) {
      return {
        updated_count: 0,
        updated_ids: [],
        not_found: [],
        show_in_pos: showInPos,
      };
    }

    return this.dataSource.transaction<BulkToggleShowInPosResult>(async (manager) => {
      const existing = await manager.find(Product, {
        where: {
          id: In(cleanIds.map(String)),
          company_id: String(companyId),
        },
        select: { id: true, show_in_pos: true },
      });

      const existingSet = new Set(existing.map((p) => Number(p.id)));
      const notFound = cleanIds.filter((id) => !existingSet.has(id));

      const idsToUpdate = existing
        .filter((p) => p.show_in_pos !== showInPos)
        .map((p) => Number(p.id));

      if (idsToUpdate.length > 0) {
        await manager.update(
          Product,
          {
            id: In(idsToUpdate.map(String)),
            company_id: String(companyId),
          },
          { show_in_pos: showInPos },
        );
      }

      this.logger.log({
        event: 'products.bulk_show_in_pos_toggled',
        companyId,
        show_in_pos: showInPos,
        updated_count: idsToUpdate.length,
        not_found_count: notFound.length,
      });

      return {
        updated_count: idsToUpdate.length,
        updated_ids: idsToUpdate,
        not_found: notFound,
        show_in_pos: showInPos,
      };
    });
  }
}
