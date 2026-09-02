import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { resolveAutoPackagingId } from '@/modules/packagings/internal/resolve-auto-packaging.helper';
import {
  propagateComponentCostToCombos,
  propagateParentCostToChildren,
  recordManualCostEditHistory,
} from '@/modules/purchases/internal/recalculate-product-costs.helper';

import type { UpdateProductDto } from '../dto/update-product.dto';
import { Product, ProductType } from '../entities/product.entity';
import {
  assertNotUsedInActiveCombos,
  clearComboComponents,
  comboCostFromComponents,
  recomputeComboCost,
  resolveComboComponents,
  syncComboComponents,
} from '../internal/combo-components.helper';
import { translateProductConstraintError } from '../internal/constraint-errors';
import {
  assertCategoryBelongsToCompany,
  assertPackagingBelongsToCompany,
  assertParentBelongsToCompany,
  assertParentIsNotCombo,
  findProductInCompany,
} from '../internal/product-lookups';
import { syncProductPrices } from '../internal/sync-product-prices';

import type { ProductCreator } from './create-product.action';

/**
 * Actualiza un producto + sus precios. Endpoint `PUT /inventory/:id`.
 *
 * Comportamiento paridad-PlacePos:
 *   - El array `prices` recibido es FUENTE DE VERDAD:
 *     * precios con `id` presente en el array → UPDATE.
 *     * precios con `id` ausente → INSERT (precio nuevo).
 *     * precios existentes cuyo `id` NO está en el array → DELETE.
 *     * si NINGÚN precio entrante trae `id` (cliente legacy), se emparejan
 *       por posición contra los existentes → UPDATE in-place en vez de
 *       DELETE+INSERT. Ver `internal/sync-product-prices.ts`.
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

      // Tipo FINAL del producto tras el patch (el cliente puede omitirlo).
      const finalProductType = dto.product_type ?? existing.product_type;
      const isCombo = finalProductType === ProductType.COMBO;

      if (!isCombo) {
        await assertParentIsNotCombo(manager, dto.parent_id ?? null, companyId);
        // Un producto que YA participa en la receta de un combo no puede
        // convertirse en presentación: su stock pasaría a vivir en otro
        // producto y la receta descontaría del sitio equivocado.
        if (existing.parent_id === null && dto.parent_id) {
          await assertNotUsedInActiveCombos(manager, companyId, [id], 'convertir en presentación');
        }
      } else if (existing.product_type !== ProductType.COMBO) {
        // …ni convertirse en COMBO: un combo no puede ser componente de otro
        // combo (la expansión es de un solo nivel, así que el combo contenedor
        // descontaría de un stock que no significa nada y los bases reales
        // nunca se tocarían).
        await assertNotUsedInActiveCombos(manager, companyId, [id], 'convertir en combo');
      }

      // El costo de un COMBO lo calcula SIEMPRE el servidor desde su receta.
      //
      // `components` ausente en un producto que YA es combo = patch parcial
      // (cambiar solo el nombre o show_in_pos): se PRESERVA la receta vigente y
      // se recalcula el costo sobre ella. Solo se exige receta cuando el
      // cliente la envía o cuando el producto se está convirtiendo en combo —
      // si no, `UpdateProductDto extends PartialType(...)` mentiría y cualquier
      // cliente una versión atrás no podría editar un combo.
      const comboComponents =
        isCombo && dto.components !== undefined
          ? await resolveComboComponents(manager, companyId, id, dto.components)
          : isCombo && existing.product_type !== ProductType.COMBO
            ? await resolveComboComponents(manager, companyId, id, dto.components ?? [])
            : null;
      const resolvedCost = comboComponents
        ? comboCostFromComponents(comboComponents)
        : isCombo
          ? // Patch parcial de un combo existente: el costo sigue derivándose de
            // su receta persistida, nunca del `cost` que mande el cliente.
            ((await recomputeComboCost(manager, companyId, id)) ?? existing.cost)
          : dto.cost;

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
      if (isCombo) {
        // Un combo vive siempre en la raíz, sin empaque ni compras.
        patch.parent_id = null;
      } else if (dto.parent_id !== undefined) {
        patch.parent_id = dto.parent_id ? String(dto.parent_id) : null;
      }
      if (dto.sku_code !== undefined) {
        patch.sku_code = (dto.sku_code ?? '').trim() || null;
      }
      if (dto.bar_code !== undefined) {
        patch.bar_code = (dto.bar_code ?? '').trim() || null;
      }
      if (isCombo) {
        patch.packaging_id = null;
      } else if (dto.packaging_id !== undefined) {
        patch.packaging_id = dto.packaging_id ? String(dto.packaging_id) : null;
      }
      // Presentaciones de peso/monto variable: si llega `packaging_value` sin
      // `packaging_id`, find-or-create de un empaque auto y se asigna como
      // packaging del producto (re-resuelve al cambiar el peso). Espejo PlacePos.
      if (
        !isCombo &&
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
      if (resolvedCost !== undefined) {
        patch.cost = resolvedCost;
      }
      // El stock de un combo es DERIVADO de sus componentes: nunca se ajusta.
      if (!isCombo && dto.stock !== undefined) {
        patch.stock = dto.stock;
      }
      // `image` no se toca aquí: la gestiona el módulo `product-images`
      // (`POST /inventory/:id/image` y `.../image/remove`), que además borra el
      // archivo anterior del bucket. Escribirla desde el patch dejaría objetos
      // huérfanos y permitiría apuntar a la carpeta de otro tenant.
      if (dto.show_in_pos !== undefined) {
        patch.show_in_pos = dto.show_in_pos;
      }
      if (isCombo) {
        patch.is_purchasable = false;
      } else if (dto.is_purchasable !== undefined) {
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

      if (comboComponents) {
        await syncComboComponents(manager, companyId, id, comboComponents);
      } else if (!isCombo && existing.product_type === ProductType.COMBO) {
        // Dejó de ser combo: su receta ya no aplica. (Un combo que sigue siendo
        // combo con `components` ausente conserva la suya: es un patch parcial.)
        await clearComboComponents(manager, companyId, id);
      }

      // Sincronizar prices si el cliente los envió.
      if (dto.prices !== undefined) {
        await syncProductPrices({
          manager,
          companyId,
          productId: existing.id,
          cost: resolvedCost !== undefined ? resolvedCost : existing.cost,
          incoming: dto.prices,
          existing: existing.prices ?? [],
          actor,
        });
      }

      // Si cambia el costo de un producto BASE, propagar a sus presentaciones
      // (cost + profit/margin de sus precios). No-op si no tiene hijos. Solo
      // aplica a base (parent_id null): una presentación no tiene presentaciones.
      if (
        resolvedCost !== undefined &&
        existing.parent_id === null &&
        !toBig(existing.cost).round(2).eq(toBig(resolvedCost).round(2))
      ) {
        // Fila de auditoría de la edición manual del propio base + propagación
        // a sus presentaciones.
        await recordManualCostEditHistory({
          manager,
          companyId,
          productId: id,
          costBefore: existing.cost,
          costAfter: resolvedCost,
          actor: { id: actor.id, fullName: actor.fullName },
        });
        if (!isCombo) {
          await propagateParentCostToChildren({
            manager,
            companyId,
            parentId: id,
            parentCost: resolvedCost,
            actor: { id: actor.id, fullName: actor.fullName },
          });
          // …y a los combos que llevan este producto en su receta.
          await propagateComponentCostToCombos({
            manager,
            companyId,
            componentId: id,
            actor: { id: actor.id, fullName: actor.fullName },
          });
        }
      }

      return manager.findOneOrFail(Product, {
        where: { id: String(id), company_id: String(companyId) },
        relations: { prices: true, packaging: true, category: true },
      });
    });
  }
}
