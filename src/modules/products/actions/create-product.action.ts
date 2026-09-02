import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { calculateMargin, calculateProfit } from '@/common/utils/precision';
import { resolveAutoPackagingId } from '@/modules/packagings/internal/resolve-auto-packaging.helper';

import type { CreateProductDto } from '../dto/create-product.dto';
import type { ProductPriceInputDto } from '../dto/product-price.dto';
import { Product, ProductType } from '../entities/product.entity';
import { ProductPrice } from '../entities/product-price.entity';
import { translateProductConstraintError } from '../internal/constraint-errors';
import {
  comboCostFromComponents,
  resolveComboComponents,
  syncComboComponents,
} from '../internal/combo-components.helper';
import {
  assertCategoryBelongsToCompany,
  assertPackagingBelongsToCompany,
  assertParentBelongsToCompany,
  assertParentIsNotCombo,
} from '../internal/product-lookups';

/**
 * Datos del actor creador. Evita propagar `AuthUser` completo.
 */
export interface ProductCreator {
  id: number;
  fullName: string;
}

/**
 * Crea un producto + sus precios atómicamente. Endpoint `POST /inventory`.
 *
 * Reglas:
 *   - `parent_id` y `packaging_id`, si presentes, DEBEN pertenecer a la
 *     misma company (pre-validación). Anti cross-tenant.
 *   - `profit` y `margin` por cada precio se RECALCULAN con Big.js
 *     (`calculateProfit` / `calculateMargin`). El cliente puede enviar
 *     valores hint que se IGNORAN — fuente única de verdad: el servidor.
 *   - `name` se trimea. SKU/barcode vacíos → null. Espejo PlacePos.
 *   - Colisiones UNIQUE → 400 con `code` específico
 *     (PRODUCT_NAME_TAKEN / PRODUCT_SKU_TAKEN / PRODUCT_BARCODE_TAKEN).
 *
 * Transacción: INSERT product + INSERT N prices DEBEN ser atómicos. Si
 * falla la inserción de prices, el product no debe quedarse huérfano.
 * `dataSource.transaction` garantiza el rollback.
 */
@Injectable()
export class CreateProductAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreateProductDto,
    companyId: number,
    createdBy: ProductCreator,
  ): Promise<Product> {
    const isCombo = dto.product_type === ProductType.COMBO;

    return this.dataSource.transaction<Product>(async (manager) => {
      // Anti cross-tenant: parent, packaging y category deben ser de la
      // misma company.
      await assertParentBelongsToCompany(manager, dto.parent_id ?? null, companyId);
      await assertPackagingBelongsToCompany(manager, dto.packaging_id ?? null, companyId);
      await assertCategoryBelongsToCompany(manager, dto.category_id ?? null, companyId);
      await assertParentIsNotCombo(manager, dto.parent_id ?? null, companyId);

      // Un COMBO se arma con N productos base: su costo lo deriva SIEMPRE el
      // servidor de la receta, nunca el `cost` que teclee el cliente. Además
      // vive en la raíz, sin empaque ni stock propios, y no es comprable.
      const comboComponents = isCombo
        ? await resolveComboComponents(manager, companyId, null, dto.components ?? [])
        : null;
      const resolvedCost = comboComponents ? comboCostFromComponents(comboComponents) : dto.cost;

      // Presentaciones de peso/monto variable: si llega `packaging_value` sin
      // `packaging_id`, find-or-create de un empaque auto con ese valor (en la
      // misma company y transacción). Espejo PlacePos.
      let packagingId = isCombo || !dto.packaging_id ? null : String(dto.packaging_id);
      if (!isCombo && !packagingId && dto.packaging_value && dto.packaging_value > 0) {
        packagingId = await resolveAutoPackagingId(manager, dto.packaging_value, companyId, {
          id: createdBy.id,
          fullName: createdBy.fullName,
        });
      }

      const trimmedName = dto.name.trim();
      const trimmedSku = (dto.sku_code ?? '').trim() || null;
      const trimmedBarcode = (dto.bar_code ?? '').trim() || null;
      const trimmedDescription = (dto.description ?? '').trim() || null;

      const product = manager.create(Product, {
        company_id: String(companyId),
        name: trimmedName,
        description: trimmedDescription,
        product_type: dto.product_type ?? ProductType.SIMPLE,
        parent_id: isCombo || !dto.parent_id ? null : String(dto.parent_id),
        sku_code: trimmedSku,
        bar_code: trimmedBarcode,
        packaging_id: packagingId,
        category_id: dto.category_id ? String(dto.category_id) : null,
        cost: resolvedCost,
        stock: isCombo ? 0 : dto.stock,
        // La imagen se sube aparte (`POST /inventory/:id/image`): un producto
        // nace sin ella y el formulario la envía en cuanto tiene el id.
        image: null,
        show_in_pos: dto.show_in_pos !== false,
        is_purchasable: isCombo ? false : dto.is_purchasable === true,
        is_archived: false,
        // PlacePos genera `hash` localmente. pos_api lo persiste passthrough.
        hash: dto.hash ?? null,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      let saved: Product;
      try {
        saved = await manager.save(Product, product);
      } catch (error) {
        translateProductConstraintError(error);
        throw error;
      }

      if (comboComponents) {
        await syncComboComponents(manager, companyId, Number(saved.id), comboComponents);
      }

      // Insertar prices. Cada uno copia `company_id` (denormalizado) y
      // recalcula profit/margin con Big.js — fuente de verdad servidor.
      const priceRows = dto.prices.map((p) => buildPriceRow(p, saved, resolvedCost, createdBy));
      await manager.insert(ProductPrice, priceRows);

      // Re-fetch con relations para devolver el product completo.
      // findOneOrFail aquí en lugar de findOne porque el INSERT confirmó
      // que existe; si findOne devolviera null sería un bug grave (race
      // contra DELETE concurrente — improbable dentro de la transacción).
      return manager.findOneOrFail(Product, {
        where: { id: saved.id, company_id: String(companyId) },
        relations: { prices: true, packaging: true, category: true },
      });
    });
  }
}

/**
 * Helper interno: construye el shape de inserción de un ProductPrice
 * recalculando profit/margin con Big.js. Exportado para testing.
 */
export function buildPriceRow(
  input: ProductPriceInputDto,
  product: Product,
  cost: number,
  createdBy: ProductCreator,
): Partial<ProductPrice> {
  return {
    company_id: product.company_id,
    product_id: product.id,
    name: input.name ?? '',
    sale_price: input.sale_price,
    profit: calculateProfit(input.sale_price, cost),
    margin: calculateMargin(input.sale_price, cost),
    iva_percentage: input.iva_percentage ?? 0,
    created_by: createdBy.fullName,
    created_by_id: String(createdBy.id),
  };
}
