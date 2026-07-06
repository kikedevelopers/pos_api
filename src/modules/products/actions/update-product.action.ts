import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';

import { calculateMargin, calculateProfit, toBig } from '@/common/utils/precision';
import { resolveAutoPackagingId } from '@/modules/packagings/internal/resolve-auto-packaging.helper';
import {
  propagateParentCostToChildren,
  recordManualCostEditHistory,
} from '@/modules/purchases/internal/recalculate-product-costs.helper';

import type { UpdateProductDto } from '../dto/update-product.dto';
import { Product } from '../entities/product.entity';
import { ProductPrice } from '../entities/product-price.entity';
import { translateProductConstraintError } from '../internal/constraint-errors';
import {
  assertCategoryBelongsToCompany,
  assertPackagingBelongsToCompany,
  assertParentBelongsToCompany,
  findProductInCompany,
} from '../internal/product-lookups';

import type { ProductCreator } from './create-product.action';

/**
 * Actualiza un producto + sus precios. Endpoint `PUT /inventory/:id`.
 *
 * Comportamiento paridad-PlacePos:
 *   - El array `prices` recibido es FUENTE DE VERDAD:
 *     * precios con `id` presente en el array → UPDATE.
 *     * precios con `id` ausente → INSERT (precio nuevo).
 *     * precios existentes cuyo `id` NO está en el array → DELETE.
 *   - `profit` y `margin` SIEMPRE recalculados con Big.js — el cliente
 *     puede enviar hints, se ignoran.
 *   - `cost` afecta a TODOS los precios (recalculan profit/margin). Si el
 *     cliente envía `prices` sin `cost`, usamos el `cost` existente para
 *     los recálculos.
 *   - 404 si el producto no existe / pertenece a otra company.
 *   - `parent_id` y `packaging_id` validados anti cross-tenant.
 *
 * Transacción: UPDATE product + DELETE/UPDATE/INSERT prices viven en una
 * sola transacción. Sin esta atomicidad, una falla parcial dejaría el
 * catálogo inconsistente.
 */
@Injectable()
export class UpdateProductAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    dto: UpdateProductDto,
    companyId: number,
    actor: ProductCreator,
  ): Promise<Product> {
    // CRIT-3 auditoría: si el cliente envía `prices: []`, el algoritmo de sync
    // calcularía `toDelete = todos los precios existentes` y dejaría el
    // producto SIN ningún nivel de precio — catálogo inutilizable en POS
    // (división por cero en cálculos posteriores). PlacePos rechaza este
    // caso; replicamos la guarda en pre-flight.
    if (dto.prices !== undefined && dto.prices.length === 0) {
      throw new BadRequestException('prices debe tener al menos 1 elemento');
    }

    return this.dataSource.transaction<Product>(async (manager) => {
      const existing = await findProductInCompany(manager, id, companyId, {
        withRelations: true,
      });

      // Validaciones anti cross-tenant para FKs.
      await assertParentBelongsToCompany(manager, dto.parent_id ?? null, companyId);
      await assertPackagingBelongsToCompany(manager, dto.packaging_id ?? null, companyId);
      await assertCategoryBelongsToCompany(manager, dto.category_id ?? null, companyId);

      // Patch de columnas del product (solo las enviadas).
      const patch: Partial<Product> = {};
      if (dto.name !== undefined) {
        patch.name = dto.name.trim();
      }
      if (dto.description !== undefined) {
        patch.description = (dto.description ?? '').trim() || null;
      }
      if (dto.product_type !== undefined) {
        patch.product_type = dto.product_type;
      }
      if (dto.parent_id !== undefined) {
        patch.parent_id = dto.parent_id ? String(dto.parent_id) : null;
      }
      if (dto.sku_code !== undefined) {
        patch.sku_code = (dto.sku_code ?? '').trim() || null;
      }
      if (dto.bar_code !== undefined) {
        patch.bar_code = (dto.bar_code ?? '').trim() || null;
      }
      if (dto.packaging_id !== undefined) {
        patch.packaging_id = dto.packaging_id ? String(dto.packaging_id) : null;
      }
      // Presentaciones de peso/monto variable: si llega `packaging_value` sin
      // `packaging_id`, find-or-create de un empaque auto y se asigna como
      // packaging del producto (re-resuelve al cambiar el peso). Espejo PlacePos.
      if (
        (dto.packaging_id === undefined || !dto.packaging_id) &&
        dto.packaging_value &&
        dto.packaging_value > 0
      ) {
        patch.packaging_id = await resolveAutoPackagingId(manager, dto.packaging_value, companyId, {
          id: actor.id,
          fullName: actor.fullName,
        });
      }
      if (dto.category_id !== undefined) {
        patch.category_id = dto.category_id ? String(dto.category_id) : null;
      }
      if (dto.cost !== undefined) {
        patch.cost = dto.cost;
      }
      if (dto.stock !== undefined) {
        patch.stock = dto.stock;
      }
      if (dto.image !== undefined) {
        patch.image = dto.image ?? null;
      }
      if (dto.show_in_pos !== undefined) {
        patch.show_in_pos = dto.show_in_pos;
      }
      if (dto.is_purchasable !== undefined) {
        patch.is_purchasable = dto.is_purchasable;
      }
      if (dto.hash !== undefined) {
        patch.hash = dto.hash ?? null;
      }
      patch.updated_by = actor.fullName;
      patch.updated_by_id = String(actor.id);

      try {
        await manager.update(Product, { id: String(id), company_id: String(companyId) }, patch);
      } catch (error) {
        translateProductConstraintError(error);
        throw error;
      }

      // Sincronizar prices si el cliente los envió.
      if (dto.prices !== undefined) {
        const effectiveCost = dto.cost !== undefined ? dto.cost : existing.cost;

        const incomingIds = dto.prices
          .map((p) => p.id)
          .filter((id): id is number => typeof id === 'number');

        const existingIds = (existing.prices ?? []).map((p) => Number(p.id));
        const toDelete = existingIds.filter((existingId) => !incomingIds.includes(existingId));

        if (toDelete.length > 0) {
          await manager.delete(ProductPrice, {
            id: In(toDelete.map((d) => String(d))),
            product_id: existing.id,
            company_id: String(companyId),
          });
        }

        for (const priceInput of dto.prices) {
          const profit = calculateProfit(priceInput.sale_price, effectiveCost);
          const margin = calculateMargin(priceInput.sale_price, effectiveCost);

          if (priceInput.id !== undefined) {
            // UPDATE — filtra por id + product_id + company_id (defensa
            // en profundidad anti cross-tenant).
            await manager.update(
              ProductPrice,
              {
                id: String(priceInput.id),
                product_id: existing.id,
                company_id: String(companyId),
              },
              {
                name: priceInput.name ?? '',
                sale_price: priceInput.sale_price,
                profit,
                margin,
                iva_percentage: priceInput.iva_percentage ?? 0,
              },
            );
          } else {
            // INSERT — nuevo nivel de precio.
            await manager.insert(ProductPrice, {
              company_id: String(companyId),
              product_id: existing.id,
              name: priceInput.name ?? '',
              sale_price: priceInput.sale_price,
              profit,
              margin,
              iva_percentage: priceInput.iva_percentage ?? 0,
              created_by: actor.fullName,
              created_by_id: String(actor.id),
            });
          }
        }
      }

      // Si cambia el costo de un producto BASE, propagar a sus presentaciones
      // (cost + profit/margin de sus precios). No-op si no tiene hijos. Solo
      // aplica a base (parent_id null): una presentación no tiene presentaciones.
      if (
        dto.cost !== undefined &&
        existing.parent_id === null &&
        !toBig(existing.cost).round(2).eq(toBig(dto.cost).round(2))
      ) {
        // Fila de auditoría de la edición manual del propio base + propagación
        // a sus presentaciones.
        await recordManualCostEditHistory({
          manager,
          companyId,
          productId: id,
          costBefore: existing.cost,
          costAfter: dto.cost,
          actor: { id: actor.id, fullName: actor.fullName },
        });
        await propagateParentCostToChildren({
          manager,
          companyId,
          parentId: id,
          parentCost: dto.cost,
          actor: { id: actor.id, fullName: actor.fullName },
        });
      }

      return manager.findOneOrFail(Product, {
        where: { id: String(id), company_id: String(companyId) },
        relations: { prices: true, packaging: true, category: true },
      });
    });
  }
}
