import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { calculateMargin, calculateProfit, preciseNumber } from '@/common/utils/precision';
import { resolveCategoryIdByName } from '@/modules/categories/internal/category-lookups';
import { propagateParentCostToChildren } from '@/modules/purchases/internal/recalculate-product-costs.helper';

import type { BulkItemDto, BulkProductsResponseDto } from '../dto/bulk-products.dto';
import { Product, ProductType } from '../entities/product.entity';
import { ProductPrice } from '../entities/product-price.entity';
import { adjustInventory } from '../internal/adjust-inventory.helper';
import { translateProductConstraintError } from '../internal/constraint-errors';

import type { ProductCreator } from './create-product.action';

/**
 * Procesa una batch de items. Endpoint `POST /inventory/bulk`.
 *
 * Espejo de la lógica de importación masiva de PlacePos
 * (`inventory.routes.ts` → `processBulkItem`), pero AISLADA por `company_id`.
 *
 * --------------------------------------------------------------------------
 * Reglas por item (paridad PlacePos)
 * --------------------------------------------------------------------------
 *
 *   - `cost = item.cost ?? 0`.
 *   - `validPrices` = `prices` con `sale_price > 0`, recalculando
 *     `profit`/`margin` con Big.js (el server es la fuente de verdad).
 *   - `tieneCodigo = !!(sku_code?.trim() || bar_code?.trim())`.
 *   - Si `tieneCodigo` → busca un producto activo de la company de forma
 *     SECUENCIAL priorizando SKU: primero por `sku_code` (si vino), y si no
 *     hay match, por `bar_code` (si vino). Existe → UPDATE; no → CREATE.
 *     (Evita el match cruzado SKU↔barcode del `OR` que podía tocar el
 *     producto equivocado — hallazgo adversarial #1.)
 *   - Si NO `tieneCodigo` → CREATE (no se puede identificar a quién actualizar).
 *   - CREATE sin precios válidos → conflict `'No tiene precios válidos.'`.
 *   - CREATE: `category` find-or-create por nombre (scoped). `show_in_pos`
 *     default `true` / `is_purchasable` default `false` cuando `undefined`.
 *   - UPDATE: `category`/`show_in_pos`/`is_purchasable`/`stock`/`product_type`
 *     se SETEAN si vienen y se PRESERVAN si `undefined`. Los precios se
 *     reemplazan SOLO si `validPrices.length > 0`.
 *   - NO-OP → `skipped`: si el estado resuelto coincide con el existente en
 *     TODOS los campos que el bulk puede cambiar, no se escribe nada (ni
 *     inventario) y se cuenta como `skipped` (hallazgo adversarial #2).
 *   - Stock en UPDATE: se ajusta de forma AUDITADA (delta vs stock actual)
 *     vía `adjustInventory` con reason `BULK_IMPORT` cuando `item.stock`
 *     viene definido y difiere del actual.
 *
 * --------------------------------------------------------------------------
 * Aislamiento de errores
 * --------------------------------------------------------------------------
 *
 * Cada item se procesa en su PROPIA transacción. Si uno falla, los otros se
 * procesan igual (PlacePos hace lo mismo: un try/catch por iteración). Las
 * violaciones de unicidad de Postgres (23505) se traducen a un `conflict`
 * con mensaje claro vía `translateProductConstraintError`.
 *
 * Multi-tenant: TODA query filtra por `company_id`.
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
        } else if (outcome.kind === 'skipped') {
          stats.skipped += 1;
        } else if (outcome.kind === 'conflict') {
          stats.conflicts.push({ name: item.name || 'unknown', reason: outcome.reason });
        }
      } catch (err) {
        stats.conflicts.push({
          name: item.name || 'unknown',
          reason: extractConflictReason(err),
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

      const cost = item.cost ?? 0;
      const validPrices = buildBulkPrices(item.prices, cost);

      const sku = item.sku_code?.trim() || null;
      const bar = item.bar_code?.trim() || null;
      const tieneCodigo = Boolean(sku || bar);

      const existing = tieneCodigo ? await findExistingByCode(manager, companyId, sku, bar) : null;

      const ctx: ItemContext = { trimmedName, cost, sku, bar, validPrices };

      if (existing) {
        return this.applyUpdate(manager, companyId, actor, existing, item, ctx);
      }

      return this.applyCreate(manager, companyId, actor, item, ctx);
    });
  }

  /**
   * CREATE de un producto nuevo. Falla con conflict si no trae precios
   * válidos (paridad PlacePos).
   */
  private async applyCreate(
    manager: EntityManager,
    companyId: number,
    actor: ProductCreator,
    item: BulkItemDto,
    ctx: ItemContext,
  ): Promise<BulkOutcome> {
    if (ctx.validPrices.length === 0) {
      return { kind: 'conflict', reason: 'No tiene precios válidos.' };
    }

    const categoryId = await resolveCategoryIdByName(manager, item.category, companyId);

    let created: Product;
    try {
      created = await manager.save(
        Product,
        manager.create(Product, {
          company_id: String(companyId),
          name: ctx.trimmedName,
          description: item.description?.trim() || null,
          sku_code: ctx.sku,
          bar_code: ctx.bar,
          category_id: categoryId,
          cost: ctx.cost,
          stock: item.stock ?? 0,
          product_type: item.product_type ?? ProductType.SIMPLE,
          show_in_pos: item.show_in_pos === undefined ? true : item.show_in_pos,
          is_purchasable: item.is_purchasable === undefined ? false : item.is_purchasable,
          is_archived: false,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        }),
      );
    } catch (error) {
      translateProductConstraintError(error);
      throw error;
    }

    await manager.insert(
      ProductPrice,
      ctx.validPrices.map((p) => buildPriceInsert(p, companyId, created.id, actor)),
    );

    return { kind: 'created' };
  }

  /**
   * UPDATE de un producto existente identificado por código. Preserva los
   * campos `undefined`; reemplaza precios solo si hay `validPrices`.
   *
   * HALLAZGO #2: si el estado resuelto coincide en TODOS los campos que el
   * bulk puede cambiar (name, sku_code, bar_code, cost, stock, product_type,
   * show_in_pos, is_purchasable, category_id y el set de precios), se cuenta
   * como `skipped` SIN tocar la BD ni el inventario. Un re-import idéntico no
   * debe inflar `updated` ni generar movimientos de inventario espurios.
   */
  private async applyUpdate(
    manager: EntityManager,
    companyId: number,
    actor: ProductCreator,
    existing: ExistingProduct,
    item: BulkItemDto,
    ctx: ItemContext,
  ): Promise<BulkOutcome> {
    // Estado resuelto de los flags/tipo (aplicando la semántica de preservación).
    const resolvedType = item.product_type ?? existing.product_type;
    const resolvedShowInPos =
      item.show_in_pos === undefined ? existing.show_in_pos : item.show_in_pos;
    const resolvedIsPurchasable =
      item.is_purchasable === undefined ? existing.is_purchasable : item.is_purchasable;
    const resolvedStock = item.stock === undefined ? existing.stock : item.stock;

    // category: la resolvemos (find-or-create) SOLO si el item la trae
    // (no vacío) — así un re-import sin categoría no crea categorías de más.
    // undefined/'' → PRESERVAR el category_id existente.
    const itemHasCategory = !(item.category === undefined || item.category.trim() === '');
    const resolvedCategoryId = itemHasCategory
      ? await resolveCategoryIdByName(manager, item.category, companyId)
      : existing.category_id;

    // description: misma semántica que category — undefined/'' → PRESERVAR la
    // actual; con valor → reemplazar (trim).
    const itemHasDescription = !(
      item.description === undefined || item.description.trim() === ''
    );
    const resolvedDescription = itemHasDescription
      ? item.description!.trim()
      : existing.description;

    // sku_code/bar_code: preserve-on-empty. El match pudo ser por UNO de los dos
    // códigos; si la fila no trae el otro (null), NO debe borrarse el del producto.
    // null → preservar el existente; con valor → reemplazar.
    const resolvedSku = ctx.sku ?? existing.sku_code;
    const resolvedBar = ctx.bar ?? existing.bar_code;

    // ----- Detección de no-op (skipped) ANTES de cualquier escritura. -----
    const existingSalePrices = await loadSalePrices(manager, companyId, existing.id);
    const isNoOp =
      existing.name === ctx.trimmedName &&
      existing.description === resolvedDescription &&
      existing.sku_code === resolvedSku &&
      existing.bar_code === resolvedBar &&
      preciseNumber(existing.cost, 2) === preciseNumber(ctx.cost, 2) &&
      preciseNumber(existing.stock, 4) === preciseNumber(resolvedStock, 4) &&
      existing.product_type === resolvedType &&
      existing.show_in_pos === resolvedShowInPos &&
      existing.is_purchasable === resolvedIsPurchasable &&
      existing.category_id === resolvedCategoryId &&
      // Precios: solo se reemplazan si hay validPrices; si están vacíos se
      // preservan (no es cambio). Si hay, comparamos el set de sale_price.
      (ctx.validPrices.length === 0 ||
        salePriceSetsEqual(
          existingSalePrices,
          ctx.validPrices.map((p) => p.sale_price),
        ));

    if (isNoOp) {
      return { kind: 'skipped' };
    }

    const categoryId = resolvedCategoryId;

    try {
      await manager.update(
        Product,
        { id: existing.id, company_id: String(companyId) },
        {
          name: ctx.trimmedName,
          description: resolvedDescription,
          sku_code: resolvedSku,
          bar_code: resolvedBar,
          category_id: categoryId,
          cost: ctx.cost,
          product_type: resolvedType,
          show_in_pos: resolvedShowInPos,
          is_purchasable: resolvedIsPurchasable,
          updated_by: actor.fullName,
          updated_by_id: String(actor.id),
        },
      );
    } catch (error) {
      translateProductConstraintError(error);
      throw error;
    }

    // Stock: si viene definido y difiere, ajuste AUDITADO (inventory_movements).
    // Si es undefined, PRESERVAR (no tocar). Paridad PlacePos
    // (`applyStockChangeWithLog`).
    if (item.stock !== undefined) {
      await applyAuditedStockChange(
        manager,
        companyId,
        Number(existing.id),
        existing.stock,
        item.stock,
        actor,
      );
    }

    // Precios: reemplazo total SOLO si hay validPrices. Si no, se preservan.
    if (ctx.validPrices.length > 0) {
      await manager.delete(ProductPrice, {
        product_id: existing.id,
        company_id: String(companyId),
      });
      await manager.insert(
        ProductPrice,
        ctx.validPrices.map((p) => buildPriceInsert(p, companyId, existing.id, actor)),
      );
    }

    // Si cambió el costo de un producto BASE, propagar a sus presentaciones
    // (cost + profit/margin de sus precios). No-op si no tiene hijos. Solo
    // aplica a base (parent_id null): una presentación no tiene presentaciones.
    if (
      existing.parent_id === null &&
      preciseNumber(existing.cost, 2) !== preciseNumber(ctx.cost, 2)
    ) {
      await propagateParentCostToChildren({
        manager,
        companyId,
        parentId: Number(existing.id),
        parentCost: ctx.cost,
        actor,
      });
    }

    return { kind: 'updated' };
  }
}

/**
 * Contexto derivado del item (normalizado una vez por iteración).
 */
interface ItemContext {
  trimmedName: string;
  cost: number;
  sku: string | null;
  bar: string | null;
  validPrices: BulkValidPrice[];
}

interface BulkValidPrice {
  sale_price: number;
  profit: number;
  margin: number;
}

interface ExistingProduct {
  id: string;
  name: string;
  description: string | null;
  sku_code: string | null;
  bar_code: string | null;
  category_id: string | null;
  parent_id: string | null;
  product_type: ProductType;
  show_in_pos: boolean;
  is_purchasable: boolean;
  stock: number;
  cost: number;
}

type BulkOutcome =
  | { kind: 'created' }
  | { kind: 'updated' }
  | { kind: 'skipped' }
  | { kind: 'conflict'; reason: string };

/**
 * Filtra precios con `sale_price > 0` y recalcula profit/margin con Big.js.
 * Espejo de `buildBulkPrices` de PlacePos.
 */
function buildBulkPrices(prices: BulkItemDto['prices'], cost: number): BulkValidPrice[] {
  return (prices ?? [])
    .filter((p) => p.sale_price > 0)
    .map((p) => ({
      sale_price: p.sale_price,
      profit: calculateProfit(p.sale_price, cost),
      margin: calculateMargin(p.sale_price, cost),
    }));
}

/**
 * Busca un producto ACTIVO de la company por código de forma SECUENCIAL,
 * priorizando SKU:
 *   1. Si vino `sku` → `sku_code = :sku AND company_id AND is_archived=false`.
 *      Si hay match, ese gana.
 *   2. Si no hubo match por SKU y vino `bar` → `bar_code = :bar AND company_id
 *      AND is_archived=false`.
 *
 * HALLAZGO #1 (paridad adversarial PlacePos): el match anterior usaba
 * `(sku_code = sku) OR (bar_code = bc)`, que con una fila que trae AMBOS
 * códigos apuntando a productos DISTINTOS de la misma company podía actualizar
 * el producto equivocado o disparar un 23505 confuso. La búsqueda secuencial
 * resuelve la ambigüedad de forma determinista (SKU manda).
 *
 * Devuelve los campos necesarios para el UPDATE y para la detección de no-op
 * (HALLAZGO #2). El filtro por `company_id` + `is_archived = false` se apoya en
 * los índices únicos parciales per-company.
 */
async function findExistingByCode(
  manager: EntityManager,
  companyId: number,
  sku: string | null,
  bar: string | null,
): Promise<ExistingProduct | null> {
  if (sku) {
    const bySku = await findByCodeColumn(manager, companyId, 'sku_code', sku);
    if (bySku) {
      return bySku;
    }
  }
  if (bar) {
    const byBar = await findByCodeColumn(manager, companyId, 'bar_code', bar);
    if (byBar) {
      return byBar;
    }
  }
  return null;
}

/**
 * Lookup de un producto activo de la company por una columna de código
 * (`sku_code` o `bar_code`). Devuelve la proyección completa para UPDATE/no-op.
 */
async function findByCodeColumn(
  manager: EntityManager,
  companyId: number,
  column: 'sku_code' | 'bar_code',
  value: string,
): Promise<ExistingProduct | null> {
  const row = await manager
    .getRepository(Product)
    .createQueryBuilder('p')
    .select([
      'p.id',
      'p.name',
      'p.description',
      'p.sku_code',
      'p.bar_code',
      'p.category_id',
      'p.parent_id',
      'p.product_type',
      'p.show_in_pos',
      'p.is_purchasable',
      'p.stock',
      'p.cost',
    ])
    .where('p.company_id = :companyId', { companyId: String(companyId) })
    .andWhere('p.is_archived = false')
    .andWhere(`p.${column} = :value`, { value })
    .getOne();

  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sku_code: row.sku_code,
    bar_code: row.bar_code,
    category_id: row.category_id,
    parent_id: row.parent_id,
    product_type: row.product_type,
    show_in_pos: row.show_in_pos,
    is_purchasable: row.is_purchasable,
    stock: Number(row.stock),
    cost: Number(row.cost),
  };
}

/**
 * Carga los `sale_price` actuales de un producto (normalizados a number con 2
 * decimales) para la detección de no-op del UPDATE. Scoped por company.
 */
async function loadSalePrices(
  manager: EntityManager,
  companyId: number,
  productId: string,
): Promise<number[]> {
  const rows = await manager.find(ProductPrice, {
    where: { product_id: productId, company_id: String(companyId) },
    select: { sale_price: true },
  });
  return rows.map((r) => preciseNumber(r.sale_price, 2));
}

/**
 * Compara dos conjuntos (multiset) de `sale_price` ignorando el orden. Se
 * normalizan a 2 decimales para evitar falsos negativos por ruido numérico.
 */
function salePriceSetsEqual(existing: number[], incoming: number[]): boolean {
  if (existing.length !== incoming.length) {
    return false;
  }
  const norm = (xs: number[]): number[] => xs.map((x) => preciseNumber(x, 2)).sort((a, b) => a - b);
  const a = norm(existing);
  const b = norm(incoming);
  return a.every((value, i) => value === b[i]);
}

/**
 * Construye el shape de inserción de un `ProductPrice` (denormaliza
 * `company_id`, copia profit/margin ya recalculados con Big.js).
 */
function buildPriceInsert(
  price: BulkValidPrice,
  companyId: number,
  productId: string,
  actor: ProductCreator,
): Partial<ProductPrice> {
  return {
    company_id: String(companyId),
    product_id: productId,
    name: '',
    sale_price: price.sale_price,
    profit: price.profit,
    margin: price.margin,
    iva_percentage: 0,
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  };
}

/**
 * Ajusta el stock de un producto al `targetStock` indicado, registrando un
 * movimiento auditado en `inventory_movements` (reason `BULK_IMPORT`). El
 * helper `adjustInventory` razona en términos de DELTAS (DEDUCT/RETURN), así
 * que calculamos la diferencia y elegimos la dirección. Si no hay diferencia,
 * no hace nada.
 *
 * Como `adjustInventory` multiplica la cantidad por `packaging.value`, le
 * pasamos `packaging_value: 1` para que el delta se aplique 1:1 en la unidad
 * base de stock (el target ya viene en unidad mínima).
 */
async function applyAuditedStockChange(
  manager: EntityManager,
  companyId: number,
  productId: number,
  currentStock: number,
  targetStock: number,
  actor: ProductCreator,
): Promise<void> {
  const delta = targetStock - currentStock;
  if (delta === 0) {
    return;
  }
  await adjustInventory(
    manager,
    companyId,
    [{ item_id: productId, quantity: Math.abs(delta), packaging_value: 1 }],
    delta > 0 ? 'RETURN' : 'DEDUCT',
    {
      reason: 'BULK_IMPORT',
      referenceType: 'manual',
      description: 'Ajuste de stock por importación masiva.',
      overrideStock: true,
      actorName: actor.fullName,
      actorUserId: actor.id,
    },
  );
}

/**
 * Extrae un mensaje de conflicto legible. Para las `HttpException` traducidas
 * (UNIQUE 23505 → BadRequest), usa el `message` de la respuesta; para errores
 * crudos, el `message` del Error.
 */
function extractConflictReason(err: unknown): string {
  if (err && typeof err === 'object' && 'getResponse' in err) {
    const response = (err as { getResponse: () => unknown }).getResponse();
    if (typeof response === 'string') {
      return response;
    }
    if (response && typeof response === 'object' && 'message' in response) {
      const msg = response.message;
      if (typeof msg === 'string') {
        return msg;
      }
      if (Array.isArray(msg)) {
        return msg.join(', ');
      }
    }
  }
  return err instanceof Error ? err.message : String(err);
}
