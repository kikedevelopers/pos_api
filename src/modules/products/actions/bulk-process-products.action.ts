import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { calculateMargin, calculateProfit } from '@/common/utils/precision';

import type { BulkItemDto, BulkProductsResponseDto } from '../dto/bulk-products.dto';
import { Product, ProductType } from '../entities/product.entity';
import { ProductPrice } from '../entities/product-price.entity';

import type { ProductCreator } from './create-product.action';

/**
 * Procesa una batch de items. Endpoint `POST /inventory/bulk`.
 *
 * Espejo de `placepos/inventory.routes.ts` (`router.post('/bulk', ...)`):
 *
 *   - Por cada item:
 *     - Busca por `name` dentro de la company.
 *     - Si existe Y se envió SKU/barcode → UPDATE + REPLACE prices.
 *     - Si existe SIN SKU/barcode → conflicto (no se puede identificar
 *       qué actualizar).
 *     - Si no existe Y trae al menos un precio válido → CREATE.
 *     - Si no existe Y no trae precios → conflicto.
 *
 * Aislamiento de errores: cada item se procesa en su PROPIA transacción.
 * Si uno falla, los otros se procesan igual. PlacePos hace lo mismo (un
 * try/catch por iteración).
 *
 * Concurrencia/cost: cada iteración abre y cierra una transacción
 * pequeña. Para 1000 items = 1000 transacciones. Si fuera problema en
 * producción, conviene chunkear en batches de 50-100 y abrir UNA
 * transacción por chunk. Para Fase 3 priorizamos paridad PlacePos.
 *
 * Multi-tenant: TODA query filtra por `company_id`.
 *
 * Profit/margin: recalculados con Big.js.
 */
@Injectable()
export class BulkProcessProductsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    items: BulkItemDto[],
    companyId: number,
    actor: ProductCreator,
  ): Promise<BulkProductsResponseDto> {
    const stats: BulkProductsResponseDto = {
      created: 0,
      updated: 0,
      skipped: 0,
      conflicts: [],
    };

    for (const item of items) {
      try {
        const outcome = await this.processOne(item, companyId, actor);
        if (outcome.kind === 'created') {
          stats.created += 1;
        } else if (outcome.kind === 'updated') {
          stats.updated += 1;
        } else if (outcome.kind === 'conflict') {
          stats.conflicts.push({ name: item.name || 'unknown', reason: outcome.reason });
        }
      } catch (err) {
        stats.conflicts.push({
          name: item.name || 'unknown',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return stats;
  }

  private async processOne(
    item: BulkItemDto,
    companyId: number,
    actor: ProductCreator,
  ): Promise<BulkOutcome> {
    return this.dataSource.transaction<BulkOutcome>(async (manager) => {
      const trimmedName = item.name?.trim();
      if (!trimmedName) {
        return { kind: 'conflict', reason: 'Nombre vacío.' };
      }

      // Match por name + company (mismo namespace que el UNIQUE parcial).
      // Buscamos activos (los archivados liberan el name).
      // HIGH-5 auditoría: incluimos `cost` (y ahora `stock`) en el SELECT
      // para poder usarlos como fallback si el cliente NO envía esos
      // campos en el bulk. Antes se persistía `cost = 0`, lo que
      // recalculaba márgenes erróneos en los precios recreados.
      const existing = await manager.findOne(Product, {
        where: { name: trimmedName, company_id: String(companyId), is_archived: false },
        select: { id: true, cost: true, stock: true },
      });

      // Determinar costo efectivo:
      //   - existe + item.cost undefined → preservar `existing.cost`.
      //   - existe + item.cost definido → adoptar el nuevo.
      //   - no existe + item.cost undefined → 0 (es el primer registro).
      const cost =
        item.cost !== undefined && item.cost !== null
          ? item.cost
          : existing
            ? Number(existing.cost)
            : 0;

      // Igual semántica para `stock`: si el bulk no lo trae, preserva el
      // del producto existente; si es nuevo, arranca en 0 (paridad con la
      // ruta `/inventory/bulk` de PlacePos línea 238/280).
      const stock =
        item.stock !== undefined && item.stock !== null
          ? item.stock
          : existing
            ? Number(existing.stock)
            : 0;

      const validPrices = (item.prices ?? [])
        .filter((p) => p.sale_price > 0)
        .map((p) => ({
          sale_price: p.sale_price,
          profit: calculateProfit(p.sale_price, cost),
          margin: calculateMargin(p.sale_price, cost),
        }));

      if (existing) {
        if (!item.sku_code && !item.bar_code) {
          return {
            kind: 'conflict',
            reason: 'Ya existe. Sin SKU/barcode no se puede actualizar.',
          };
        }

        await manager.update(
          Product,
          { id: existing.id, company_id: String(companyId) },
          {
            sku_code: item.sku_code || null,
            bar_code: item.bar_code || null,
            description: item.description || null,
            cost,
            stock,
            updated_by: actor.fullName,
            updated_by_id: String(actor.id),
          },
        );

        if (validPrices.length > 0) {
          await manager.delete(ProductPrice, {
            product_id: existing.id,
            company_id: String(companyId),
          });
          await manager.insert(
            ProductPrice,
            validPrices.map((p) => ({
              company_id: String(companyId),
              product_id: existing.id,
              name: '',
              sale_price: p.sale_price,
              profit: p.profit,
              margin: p.margin,
              iva_percentage: 0,
              created_by: actor.fullName,
              created_by_id: String(actor.id),
            })),
          );
        }
        return { kind: 'updated' };
      }

      // No existe → CREATE si trae precios válidos.
      if (validPrices.length === 0) {
        return { kind: 'conflict', reason: 'No tiene precios válidos.' };
      }

      const created = await manager.save(
        Product,
        manager.create(Product, {
          company_id: String(companyId),
          name: trimmedName,
          description: item.description || null,
          bar_code: item.bar_code || null,
          sku_code: item.sku_code || null,
          cost,
          stock,
          product_type: item.product_type ?? ProductType.SIMPLE,
          show_in_pos: true,
          is_purchasable: false,
          is_archived: false,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        }),
      );

      await manager.insert(
        ProductPrice,
        validPrices.map((p) => ({
          company_id: String(companyId),
          product_id: created.id,
          name: '',
          sale_price: p.sale_price,
          profit: p.profit,
          margin: p.margin,
          iva_percentage: 0,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        })),
      );

      return { kind: 'created' };
    });
  }
}

type BulkOutcome = { kind: 'created' } | { kind: 'updated' } | { kind: 'conflict'; reason: string };
