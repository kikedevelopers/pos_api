import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';

import { Product } from '../entities/product.entity';

/**
 * Resultado del bulk archive. Espejo PlacePos (`{ archived: N }`), pero
 * añadimos `archived_ids` y `not_found` para que el cliente sepa qué se
 * aplicó y qué quedó fuera (ids inexistentes o de otra company).
 */
export interface BulkArchiveResult {
  archived_count: number;
  archived_ids: number[];
  not_found: number[];
}

/**
 * `PUT /inventory/archive` — Archivado bulk de productos.
 *
 * Espejo de PlacePos `inventory.routes.ts` línea 158-174. Bajo el patrón
 * multi-tenant, además del array de `ids` enviado por el cliente exigimos
 * el filtro `company_id` para nunca tocar productos de otra company.
 *
 * Comportamiento:
 *   - Filtra `ids` que existan en la company. Los ids que no existan se
 *     reportan en `not_found` (no se ignoran silenciosamente — el cliente
 *     debe saberlo).
 *   - Idempotente: archivar uno ya archivado no falla; el row se cuenta
 *     en `archived_ids` solo si la fila pasaba de `false → true`.
 *   - Si `ids` está vacío después del filtrado, devuelve ceros sin tocar
 *     la DB.
 *
 * Transacción: §8.8 — toda mutación va en transacción aunque sea un único
 * UPDATE.
 */
@Injectable()
export class BulkArchiveProductsAction {
  private readonly logger = new Logger(BulkArchiveProductsAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(ids: number[], companyId: number): Promise<BulkArchiveResult> {
    // Dedup y filtrado básico — defensa contra payloads ruidosos del cliente.
    const cleanIds = Array.from(new Set(ids.filter((n) => Number.isInteger(n) && n > 0)));
    if (cleanIds.length === 0) {
      return { archived_count: 0, archived_ids: [], not_found: [] };
    }

    return this.dataSource.transaction<BulkArchiveResult>(async (manager) => {
      const existing = await manager.find(Product, {
        where: {
          id: In(cleanIds.map(String)),
          company_id: String(companyId),
        },
        select: { id: true, is_archived: true },
      });

      const existingIds = existing.map((p) => Number(p.id));
      const existingSet = new Set(existingIds);
      const notFound = cleanIds.filter((id) => !existingSet.has(id));

      const idsToArchive = existing.filter((p) => p.is_archived === false).map((p) => Number(p.id));

      if (idsToArchive.length > 0) {
        await manager.update(
          Product,
          {
            id: In(idsToArchive.map(String)),
            company_id: String(companyId),
          },
          { is_archived: true },
        );
      }

      this.logger.log({
        event: 'products.bulk_archived',
        companyId,
        archived_count: idsToArchive.length,
        not_found_count: notFound.length,
      });

      return {
        archived_count: idsToArchive.length,
        archived_ids: idsToArchive,
        not_found: notFound,
      };
    });
  }
}
