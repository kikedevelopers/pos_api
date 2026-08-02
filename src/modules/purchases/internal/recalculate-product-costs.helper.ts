import Big from 'big.js';
import { In, type EntityManager } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';
import {
  findCombosUsingComponents,
  recomputeComboCost,
} from '@/modules/products/internal/combo-components.helper';
import {
  ProductCostHistory,
  ProductCostHistoryDerivedFrom,
  ProductCostHistoryEvent,
} from '@/modules/product-history/entities/product-cost-history.entity';
import { ProductPriceHistory } from '@/modules/product-history/entities/product-price-history.entity';

import { Purchase, PurchaseStatus } from '../entities/purchase.entity';
import { PurchaseLine } from '../entities/purchase-line.entity';

/**
 * Maquinaria de costeo por compra (promedio ponderado) — PORTE de
 * `placepos/src/main/database/purchaseReceiveOperations.ts`, ya con flete
 * integrado. Adaptaciones obligatorias para el cloud multi-tenant:
 *
 *   (a) MULTI-TENANT: `company_id` en TODO find/lock/insert/update. Los locks
 *       pessimistic_write filtran `company_id` y ordenan por id ASC
 *       (anti-deadlock).
 *   (b) Sin `getCurrentUser()`: el actor `{ id, fullName }` se recibe por
 *       params (igual que el resto de actions de pos_api). Se persiste en
 *       `created_by`/`created_by_id` del cost-history y price-history.
 *
 * --------------------------------------------------------------------------
 * DIVERGENCIA OBLIGATORIA con placepos (modelo de stock distinto)
 * --------------------------------------------------------------------------
 *
 * En placepos `computeStockDelta(line) = packaging_qty × packaging_value`
 * (el embalaje multiplica el stock). En pos_api el embalaje en compras es
 * SOLO INFORMATIVO: el stock se carga/revierte con `unit_qty` DIRECTO
 * (ver mark-purchase-received / archive / update actions, todos con
 * `packaging_value: 1`). Por eso aquí el "peso" de cada línea es `unit_qty`:
 * es la única magnitud coherente con el stock que realmente cambia, y por
 * tanto la única que hace correcto el promedio ponderado. Replicar
 * `packaging_qty × packaging_value` desalinearía el costo respecto al stock.
 *
 * Base de costo intacta: `line.subtotal` (sin IVA), igual que placepos.
 * El flete se SUMA al costo base por unidad mínima ANTES de la ponderación.
 */

/** Razón por la que un hijo no recibió propagación de costo. */
export type SkipReason = 'NO_PACKAGING' | 'NO_PACKAGING_VALUE' | 'ZERO_PACKAGING_VALUE';

export interface SkippedChild {
  id: number;
  name: string;
  reason: SkipReason;
}

export interface RecalcResult {
  skipped: SkippedChild[];
}

/** Actor que origina el recálculo. Reemplaza `getCurrentUser()` de placepos. */
export interface RecalcActor {
  id: number;
  fullName: string;
}

export interface RecalcOptions {
  eventType: ProductCostHistoryEvent;
  /** Id de la compra que origina el evento (puede ser null en escenarios sin compra). */
  purchaseId: number | null;
  /** Tenant. Filtra TODO acceso a DB. */
  companyId: number;
  /**
   * Costo de transporte (flete) de la compra completa. Se prorratea de forma
   * uniforme entre TODAS las líneas por peso (`computeStockDelta`) y se suma
   * al costo base por unidad mínima antes de la ponderación.
   */
  transportCost: number;
  actor: RecalcActor;
  /**
   * Override de `stockBefore` por producto (id → Big). En edición de compra
   * RECEIVED los deltas de stock ya fueron aplicados, así que el stock leído
   * de la DB es el posterior; aquí pasamos el anterior al delta para preservar
   * la ponderación correcta.
   */
  stockBeforeOverrides?: Map<number, Big>;
}

/**
 * Peso/cantidad de una línea en unidad mínima de stock. En pos_api es
 * `unit_qty` directo (embalaje informativo — ver nota de cabecera).
 */
export function computeStockDelta(line: Pick<PurchaseLine, 'unit_qty'>): Big {
  return toBig(line.unit_qty);
}

/**
 * Costo base por unidad MÍNIMA efectivo en esta compra =
 * Σ subtotal / Σ unidades base. Se ignora IVA. `null` si no hay unidades o
 * subtotal positivos (no hay nada que costear).
 */
function computePurchaseUnitMinCost(lines: PurchaseLine[]): Big | null {
  let totalSubtotal = new Big(0);
  let totalUnits = new Big(0);
  for (const line of lines) {
    const units = computeStockDelta(line);
    if (units.lte(0)) {
      continue;
    }
    totalSubtotal = totalSubtotal.plus(toBig(line.subtotal));
    totalUnits = totalUnits.plus(units);
  }
  if (totalUnits.lte(0) || totalSubtotal.lte(0)) {
    return null;
  }
  return totalSubtotal.div(totalUnits);
}

/**
 * Flete prorrateado por unidad mínima, uniforme para TODA la compra:
 *   fletePorUdMin = transportCost / sigmaPeso
 * donde sigmaPeso = Σ computeStockDelta(line) sobre TODAS las líneas con
 * peso > 0. Si no hay flete (<=0) o no hay peso, devuelve Big(0). Sin
 * redondear: la precisión se conserva hasta el costo final.
 */
function computeFletePorUdMin(
  lines: Array<Pick<PurchaseLine, 'unit_qty'>>,
  transportCost: Big,
): Big {
  if (transportCost.lte(0)) {
    return new Big(0);
  }
  let sigmaPeso = new Big(0);
  for (const line of lines) {
    const peso = computeStockDelta(line);
    if (peso.gt(0)) {
      sigmaPeso = sigmaPeso.plus(peso);
    }
  }
  if (sigmaPeso.lte(0)) {
    return new Big(0);
  }
  return transportCost.div(sigmaPeso);
}

function sumStockDelta(lines: PurchaseLine[]): Big {
  let total = new Big(0);
  for (const line of lines) {
    const qty = computeStockDelta(line);
    if (qty.gt(0)) {
      total = total.plus(qty);
    }
  }
  return total;
}

interface WeightedArgs {
  stockBefore: Big;
  costBefore: Big;
  deltaUnits: Big;
  costPurchase: Big;
}

function weightedAverageCost(args: WeightedArgs): Big {
  const { stockBefore, costBefore, deltaUnits, costPurchase } = args;
  if (stockBefore.lte(0) || costBefore.lte(0)) {
    return costPurchase;
  }
  const numerator = stockBefore.times(costBefore).plus(deltaUnits.times(costPurchase));
  const denominator = stockBefore.plus(deltaUnits);
  if (denominator.lte(0)) {
    return costPurchase;
  }
  return numerator.div(denominator);
}

/**
 * Carga el `value` de un Packaging dentro de la company. Devuelve Big(1) si no
 * hay packaging (producto sin empaque) o si el valor es <=0, de modo que las
 * conversiones de unidad (× / ÷) degraden a identidad.
 */
async function loadPackagingValue(
  manager: EntityManager,
  companyId: number,
  packagingId: string | null,
): Promise<Big> {
  if (packagingId === null) {
    return new Big(1);
  }
  const pkg = await manager.findOne(Packaging, {
    where: { id: packagingId, company_id: String(companyId) },
    select: { id: true, value: true },
  });
  if (!pkg || pkg.value === null) {
    return new Big(1);
  }
  const value = toBig(pkg.value);
  if (value.lte(0)) {
    return new Big(1);
  }
  return value;
}

/**
 * Lockea un producto con pessimistic_write filtrando `company_id`. Devuelve
 * null si no existe en la company.
 */
async function lockProduct(
  manager: EntityManager,
  companyId: number,
  productId: number,
): Promise<Product | null> {
  return manager
    .createQueryBuilder(Product, 'p')
    .setLock('pessimistic_write')
    .where('p.id = :id AND p.company_id = :companyId', {
      id: String(productId),
      companyId: String(companyId),
    })
    .getOne();
}

interface ApplyCostArgs {
  manager: EntityManager;
  companyId: number;
  product: Product;
  costBefore: Big;
  costAfter: Big;
  derivedFrom: ProductCostHistoryDerivedFrom;
  eventType: ProductCostHistoryEvent;
  purchaseId: number | null;
  actor: RecalcActor;
}

/**
 * Persiste el nuevo cost en Product, refresca ProductPrice (solo profit/margin,
 * sale_price intacto) y registra cost-history + price-history en la misma
 * transacción. Si cost_after === cost_before (a 2 decimales) no se inserta nada.
 *
 * Respeta el CHECK `cost >= 0`: el promedio ponderado de costos no-negativos
 * nunca produce negativos, pero clampeamos a 0 defensivamente.
 */
async function applyCostChange(args: ApplyCostArgs): Promise<void> {
  const { manager, companyId, product, costBefore, costAfter } = args;
  const costAfterRounded = costAfter.lt(0) ? new Big(0) : costAfter.round(2, Big.roundHalfUp);
  const costBeforeRounded = costBefore.round(2, Big.roundHalfUp);
  if (costAfterRounded.eq(costBeforeRounded)) {
    return;
  }

  await manager.update(
    Product,
    { id: product.id, company_id: String(companyId) },
    { cost: costAfterRounded.toNumber() },
  );

  const costHistoryId = await insertCostHistory(args, costBeforeRounded, costAfterRounded);
  await refreshAndLogProductPrices({
    manager,
    companyId,
    productId: product.id,
    costBefore: costBeforeRounded,
    costAfter: costAfterRounded,
    costHistoryId,
    actor: args.actor,
  });
}

async function insertCostHistory(
  args: ApplyCostArgs,
  costBefore: Big,
  costAfter: Big,
): Promise<string> {
  const { manager, companyId, product, derivedFrom, eventType, purchaseId, actor } = args;
  const changePct = costBefore.gt(0)
    ? costAfter.minus(costBefore).div(costBefore).times(100).round(4, Big.roundHalfUp).toNumber()
    : 0;

  const inserted = await manager.insert(ProductCostHistory, {
    company_id: String(companyId),
    product_id: product.id,
    purchase_id: purchaseId !== null ? String(purchaseId) : null,
    event_type: eventType,
    derived_from: derivedFrom,
    cost_before: costBefore.round(4, Big.roundHalfUp).toNumber(),
    cost_after: costAfter.round(4, Big.roundHalfUp).toNumber(),
    change_pct: changePct,
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  });
  return inserted.identifiers[0].id as string;
}

interface RefreshPricesArgs {
  manager: EntityManager;
  companyId: number;
  productId: string;
  costBefore: Big;
  costAfter: Big;
  costHistoryId: string;
  actor: RecalcActor;
}

/**
 * Recalcula profit/margin de cada ProductPrice del producto contra el nuevo
 * costo. `sale_price` NO se toca (solo profit/margin) — paridad placepos.
 * Inserta un snapshot en product_price_history por cada precio afectado.
 */
async function refreshAndLogProductPrices(args: RefreshPricesArgs): Promise<void> {
  const { manager, companyId, productId, costBefore, costAfter, costHistoryId, actor } = args;
  const prices = await manager.find(ProductPrice, {
    where: { product_id: productId, company_id: String(companyId) },
    select: { id: true, sale_price: true, profit: true, margin: true },
  });
  for (const price of prices) {
    const sale = toBig(price.sale_price);
    const profitBefore = sale.minus(costBefore);
    const marginBefore = sale.gt(0) ? profitBefore.div(sale).times(100) : new Big(0);
    const profitAfter = sale.minus(costAfter);
    const marginAfter = sale.gt(0) ? profitAfter.div(sale).times(100) : new Big(0);

    await manager.update(
      ProductPrice,
      { id: price.id, company_id: String(companyId) },
      {
        profit: profitAfter.round(2, Big.roundHalfUp).toNumber(),
        margin: marginAfter.round(4, Big.roundHalfUp).toNumber(),
      },
    );
    await manager.insert(ProductPriceHistory, {
      company_id: String(companyId),
      product_price_id: price.id,
      product_id: productId,
      cost_history_id: costHistoryId,
      sale_price: sale.round(2, Big.roundHalfUp).toNumber(),
      profit_before: profitBefore.round(4, Big.roundHalfUp).toNumber(),
      margin_before: marginBefore.round(4, Big.roundHalfUp).toNumber(),
      profit_after: profitAfter.round(4, Big.roundHalfUp).toNumber(),
      margin_after: marginAfter.round(4, Big.roundHalfUp).toNumber(),
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    });
  }
}

interface PropagateChildrenArgs {
  manager: EntityManager;
  companyId: number;
  parentId: number;
  /** Costo del padre en unidad MÍNIMA. El cost del hijo = parentCostMin × child.pkg.value. */
  parentCostMin: Big;
  eventType: ProductCostHistoryEvent;
  purchaseId: number | null;
  actor: RecalcActor;
  skipped: SkippedChild[];
}

/**
 * Propaga el costo recién ponderado a los hijos (combos derivados): el cost
 * del hijo es `parentCostMin × child.pkg.value`. NO se aplica promedio
 * ponderado al hijo (sería doble ponderación). Multi-tenant en todo acceso.
 */
async function propagateToChildren(args: PropagateChildrenArgs): Promise<void> {
  const { manager, companyId, parentId, parentCostMin, eventType, purchaseId, actor, skipped } =
    args;
  const children = await manager.find(Product, {
    where: {
      parent_id: String(parentId),
      company_id: String(companyId),
      is_archived: false,
    },
    select: { id: true, name: true, packaging_id: true },
  });
  if (children.length === 0) {
    return;
  }

  const packagingIds = Array.from(
    new Set(children.map((c) => c.packaging_id).filter((id): id is string => id !== null)),
  );
  const packagings =
    packagingIds.length > 0
      ? await manager.find(Packaging, {
          where: { id: In(packagingIds), company_id: String(companyId) },
          select: { id: true, value: true },
        })
      : [];
  const packagingById = new Map(packagings.map((p) => [p.id, p]));

  for (const child of children) {
    if (child.packaging_id === null) {
      skipped.push({ id: Number(child.id), name: child.name, reason: 'NO_PACKAGING' });
      continue;
    }
    const pkg = packagingById.get(child.packaging_id);
    if (!pkg || pkg.value === null) {
      skipped.push({ id: Number(child.id), name: child.name, reason: 'NO_PACKAGING_VALUE' });
      continue;
    }
    const pkgValue = toBig(pkg.value);
    if (pkgValue.lte(0)) {
      skipped.push({ id: Number(child.id), name: child.name, reason: 'ZERO_PACKAGING_VALUE' });
      continue;
    }

    const lockedChild = await lockProduct(manager, companyId, Number(child.id));
    if (!lockedChild) {
      continue;
    }
    const childCostBefore = toBig(lockedChild.cost);
    const childCostAfter = parentCostMin.times(pkgValue);
    await applyCostChange({
      manager,
      companyId,
      product: lockedChild,
      costBefore: childCostBefore,
      costAfter: childCostAfter,
      derivedFrom: ProductCostHistoryDerivedFrom.PARENT,
      eventType,
      purchaseId,
      actor,
    });
  }
}

/**
 * Propaga el cost de un producto PADRE a sus presentaciones cuando el costo se
 * edita FUERA de una compra (formulario de producto o importación masiva). Reusa
 * la maquinaria de las compras: por cada hijo recalcula su cost
 * (= parentCostMin × child.pkg.value) y refresca profit/margin de TODOS sus
 * precios, dejando historial (event EDIT, derived_from PARENT, sin purchase_id).
 * No-op si el producto no tiene hijos o si el cost derivado de un hijo no cambia.
 * `parentCost` es el costo FINAL del padre (en su unidad de empaque);
 * parentCostMin = parentCost / parent.pkg.value. Multi-tenant.
 */
/**
 * Propaga el cambio de costo de un producto BASE a los COMBOS que lo llevan en
 * su receta. El costo del combo es DERIVADO (Σ de los aportes de sus
 * componentes), así que cada vez que cambia el costo de un componente hay que
 * recalcularlo y refrescar profit/margin de sus precios — misma maquinaria que
 * la propagación padre→presentaciones (`applyCostChange`), con
 * derived_from COMBO. No-op si el producto no participa en ningún combo activo
 * o si el costo derivado no cambia. Espejo de placepos.
 */
export async function propagateComponentCostToCombos(args: {
  manager: EntityManager;
  companyId: number;
  /** Uno o varios componentes. En lote = UNA sola consulta para todos. */
  componentId: number | number[];
  actor: RecalcActor;
  eventType?: ProductCostHistoryEvent;
  purchaseId?: number | null;
}): Promise<void> {
  const { manager, companyId, actor } = args;
  const ids = Array.isArray(args.componentId) ? args.componentId : [args.componentId];
  if (ids.length === 0) {
    return;
  }

  // UNA sola consulta para todo el lote. Recibir una compra de 200 líneas no
  // puede costar 200 SELECT en un negocio que no tiene ni un combo.
  const usage = await findCombosUsingComponents(manager, companyId, ids);
  if (usage.size === 0) {
    return;
  }

  // Dedupe: si la compra tocó dos componentes del MISMO combo, se recalcula una
  // vez (recomputeComboCost ya lee la receta completa). Recalcularlo dos veces
  // dejaría una fila intermedia espuria en product_cost_history. Orden
  // ascendente por id para lockear siempre igual y no provocar deadlocks.
  const comboIds = [
    ...new Set(
      Array.from(usage.values())
        .flat()
        .map((combo) => combo.id),
    ),
  ].sort((a, b) => a - b);

  for (const comboId of comboIds) {
    const costAfter = await recomputeComboCost(manager, companyId, comboId);
    if (costAfter === null) {
      continue;
    }
    const lockedCombo = await lockProduct(manager, companyId, comboId);
    if (!lockedCombo) {
      continue;
    }
    await applyCostChange({
      manager,
      companyId,
      product: lockedCombo,
      costBefore: toBig(lockedCombo.cost),
      costAfter: toBig(costAfter),
      derivedFrom: ProductCostHistoryDerivedFrom.COMBO,
      eventType: args.eventType ?? ProductCostHistoryEvent.EDIT,
      purchaseId: args.purchaseId ?? null,
      actor,
    });
  }
}

export async function propagateParentCostToChildren(args: {
  manager: EntityManager;
  companyId: number;
  parentId: number;
  parentCost: number;
  actor: RecalcActor;
}): Promise<RecalcResult> {
  const { manager, companyId, parentId, parentCost, actor } = args;
  const parent = await manager.findOne(Product, {
    where: { id: String(parentId), company_id: String(companyId) },
    select: { id: true, packaging_id: true },
  });
  if (!parent) {
    return { skipped: [] };
  }

  const parentPkgValue = await loadPackagingValue(manager, companyId, parent.packaging_id);
  const parentCostMin = toBig(parentCost).div(parentPkgValue);

  const skipped: SkippedChild[] = [];
  await propagateToChildren({
    manager,
    companyId,
    parentId,
    parentCostMin,
    eventType: ProductCostHistoryEvent.EDIT,
    purchaseId: null,
    actor,
    skipped,
  });
  return { skipped };
}

/**
 * Registra la edición MANUAL del costo del PROPIO producto (event EDIT,
 * derived_from MANUAL, sin purchase_id), además de la propagación a hijos. El
 * `Product.cost` ya lo actualizó el caller (update-product.action); aquí solo
 * dejamos la fila de auditoría. No-op si el costo no cambió (a 2 decimales).
 * Espejo de placepos `recordManualCostEditHistory`.
 */
export async function recordManualCostEditHistory(args: {
  manager: EntityManager;
  companyId: number;
  productId: number;
  costBefore: number;
  costAfter: number;
  actor: RecalcActor;
}): Promise<void> {
  const { manager, companyId, productId, actor } = args;
  const before = toBig(args.costBefore);
  const after = toBig(args.costAfter);
  if (before.round(2).eq(after.round(2))) {
    return;
  }

  const changePct = before.gt(0)
    ? after.minus(before).div(before).times(100).round(4, Big.roundHalfUp).toNumber()
    : 0;

  await manager.insert(ProductCostHistory, {
    company_id: String(companyId),
    product_id: String(productId),
    purchase_id: null,
    event_type: ProductCostHistoryEvent.EDIT,
    derived_from: ProductCostHistoryDerivedFrom.MANUAL,
    cost_before: before.round(4, Big.roundHalfUp).toNumber(),
    cost_after: after.round(4, Big.roundHalfUp).toNumber(),
    change_pct: changePct,
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  });
}

/**
 * Recalcula `Product.cost` con promedio ponderado a partir de las líneas de
 * una compra. Multi-tenant en TODO acceso a DB.
 *
 * Flujo por producto: cost_before (empaque) → cost_before_min (÷ pkg.value)
 * → ponderación con flete sumado → cost_new_min → cost_new (× pkg.value)
 * → persistido en Product.cost. Propaga a hijos y registra historial.
 */
export async function recalculateProductCosts(
  manager: EntityManager,
  lines: PurchaseLine[],
  options: RecalcOptions,
): Promise<RecalcResult> {
  const linesByProduct = new Map<number, PurchaseLine[]>();
  for (const line of lines) {
    if (line.product_id === null) {
      continue;
    }
    const productId = Number(line.product_id);
    const list = linesByProduct.get(productId) ?? [];
    list.push(line);
    linesByProduct.set(productId, list);
  }

  const skipped: SkippedChild[] = [];

  // Flete por unidad mínima, uniforme para TODA la compra (sigmaPeso sobre el
  // arg `lines` completo). Sin redondear hasta el costo final.
  const fletePorUdMin = computeFletePorUdMin(lines, toBig(options.transportCost ?? 0));

  // Orden ASC por productId: anti-deadlock al lockear productos concurrentes.
  const sortedEntries = Array.from(linesByProduct.entries()).sort((a, b) => a[0] - b[0]);

  for (const [productId, productLines] of sortedEntries) {
    const baseMin = computePurchaseUnitMinCost(productLines);
    if (!baseMin) {
      continue;
    }
    const purchaseUnitMinCost = baseMin.plus(fletePorUdMin);

    const product = await lockProduct(manager, options.companyId, productId);
    if (!product) {
      continue;
    }

    const parentPkgValue = await loadPackagingValue(
      manager,
      options.companyId,
      product.packaging_id,
    );

    const stockBefore = options.stockBeforeOverrides?.get(productId) ?? toBig(product.stock);
    const costBefore = toBig(product.cost);
    const costBeforeMin = costBefore.div(parentPkgValue);
    const totalUnits = sumStockDelta(productLines);

    const costNewMin = weightedAverageCost({
      stockBefore,
      costBefore: costBeforeMin,
      deltaUnits: totalUnits,
      costPurchase: purchaseUnitMinCost,
    });

    const costAfter = costNewMin.times(parentPkgValue);

    await applyCostChange({
      manager,
      companyId: options.companyId,
      product,
      costBefore,
      costAfter,
      derivedFrom: ProductCostHistoryDerivedFrom.PURCHASE,
      eventType: options.eventType,
      purchaseId: options.purchaseId,
      actor: options.actor,
    });

    await propagateToChildren({
      manager,
      companyId: options.companyId,
      parentId: productId,
      parentCostMin: costNewMin,
      eventType: options.eventType,
      purchaseId: options.purchaseId,
      actor: options.actor,
      skipped,
    });
  }

  // Y a los COMBOS que llevan alguno de estos productos en su receta. FUERA del
  // bucle: una sola consulta para toda la compra y cada combo recalculado una
  // única vez aunque la compra toque varios de sus componentes.
  await propagateComponentCostToCombos({
    manager,
    companyId: options.companyId,
    componentId: [...linesByProduct.keys()],
    actor: options.actor,
    eventType: options.eventType,
    purchaseId: options.purchaseId,
  });

  return { skipped };
}

interface RecalcFromLastActiveArgs {
  manager: EntityManager;
  companyId: number;
  productId: number;
  eventType: ProductCostHistoryEvent;
  currentPurchaseId: number;
  actor: RecalcActor;
  skipped: SkippedChild[];
  /** Override de stock previo (mismo patrón que stockBeforeOverrides). */
  stockBeforeOverride?: Big;
}

/**
 * Recalcula el costo a partir de la última compra activa que contenga el
 * producto (status=RECEIVED, is_deleted=false, id != current, misma company).
 * Si existe, promedio ponderado contra el stock que quede; si no, conserva el
 * costo actual pero igual registra el evento para auditoría. Se usa en archive
 * y en edit cuando un producto pierde su línea en la compra.
 */
export async function recalcCostFromLastActivePurchase(
  args: RecalcFromLastActiveArgs,
): Promise<void> {
  const { manager, companyId, productId, eventType, currentPurchaseId, actor, skipped } = args;
  const product = await lockProduct(manager, companyId, productId);
  if (!product) {
    return;
  }

  const parentPkgValue = await loadPackagingValue(manager, companyId, product.packaging_id);
  const costBefore = toBig(product.cost);
  const costBeforeMin = costBefore.div(parentPkgValue);
  const stockBefore = args.stockBeforeOverride ?? toBig(product.stock);

  const lastActive = await findLastActivePurchaseLines(
    manager,
    companyId,
    productId,
    currentPurchaseId,
  );
  let costAfterMin: Big = costBeforeMin;
  if (lastActive && lastActive.lines.length > 0) {
    const baseMin = computePurchaseUnitMinCost(lastActive.lines);
    if (baseMin) {
      // Reprorrateo del flete de ESA compra: sigmaPeso sobre SUS líneas
      // (allLines), no las de la compra actual. Paridad con RECEIVE/EDIT.
      const fletePorUdMin = computeFletePorUdMin(
        lastActive.allLines,
        toBig(lastActive.transportCost),
      );
      const purchaseUnitMinCost = baseMin.plus(fletePorUdMin);
      const units = sumStockDelta(lastActive.lines);
      costAfterMin = weightedAverageCost({
        stockBefore,
        costBefore: costBeforeMin,
        deltaUnits: units,
        costPurchase: purchaseUnitMinCost,
      });
    }
  }

  const costAfter = costAfterMin.times(parentPkgValue);

  await applyCostChange({
    manager,
    companyId,
    product,
    costBefore,
    costAfter,
    derivedFrom: ProductCostHistoryDerivedFrom.PURCHASE,
    eventType,
    purchaseId: currentPurchaseId,
    actor,
  });

  await propagateToChildren({
    manager,
    companyId,
    parentId: productId,
    parentCostMin: costAfterMin,
    eventType,
    purchaseId: currentPurchaseId,
    actor,
    skipped,
  });

  await propagateComponentCostToCombos({
    manager,
    companyId,
    componentId: productId,
    actor,
    eventType,
    purchaseId: currentPurchaseId,
  });
}

interface LastActivePurchase {
  /** Líneas del PRODUCTO en la última compra activa (para baseMin y units). */
  lines: PurchaseLine[];
  /** Flete de esa compra (para reprorrateo). */
  transportCost: number;
  /** TODAS las líneas de la compra (para sigmaPeso del flete). */
  allLines: PurchaseLine[];
}

/**
 * Halla la última compra activa (RECEIVED, no borrada, distinta de la actual,
 * misma company) que contenga el producto, y trae su flete + todas sus líneas.
 */
async function findLastActivePurchaseLines(
  manager: EntityManager,
  companyId: number,
  productId: number,
  excludePurchaseId: number,
): Promise<LastActivePurchase | null> {
  const lastPurchase = await manager
    .createQueryBuilder(Purchase, 'p')
    .innerJoin(PurchaseLine, 'pl', 'pl.purchase_id = p.id')
    .where('pl.product_id = :productId', { productId: String(productId) })
    .andWhere('p.company_id = :companyId', { companyId: String(companyId) })
    .andWhere('p.id != :excludeId', { excludeId: String(excludePurchaseId) })
    .andWhere('p.is_deleted = false')
    .andWhere('p.status = :status', { status: PurchaseStatus.RECEIVED })
    .orderBy('p.received_at', 'DESC')
    .addOrderBy('p.id', 'DESC')
    .select('p.id', 'id')
    .addSelect('p.transport_cost', 'transport_cost')
    .getRawOne<{ id: string; transport_cost: number | string | null }>();
  if (!lastPurchase) {
    return null;
  }
  const allLines = await manager.find(PurchaseLine, {
    where: { purchase_id: String(lastPurchase.id), company_id: String(companyId) },
  });
  const lines = allLines.filter((l) => Number(l.product_id) === productId);
  return {
    lines,
    transportCost: Number(lastPurchase.transport_cost ?? 0),
    allLines,
  };
}
