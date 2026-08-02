import { Logger, UnprocessableEntityException } from '@nestjs/common';
import Big from 'big.js';
import { In, type EntityManager } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '@/modules/app-settings/entities/app-setting.entity';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';

import { ComboComponent } from '../entities/combo-component.entity';
import {
  InventoryMovement,
  type InventoryMovementDirection,
  type InventoryMovementReason,
  type InventoryMovementReferenceType,
} from '../entities/inventory-movement.entity';
import { Product, ProductType } from '../entities/product.entity';

import { resolveAccessibleProducts } from './accessible-products.helper';

/**
 * Línea de inventario que entra al ajuste. `quantity` está en la unidad de
 * venta del producto (no en la unidad mínima de stock); el helper se encarga
 * de multiplicar por `packaging.value` para llevarla a la unidad base donde
 * vive `Product.stock`.
 */
export interface InventoryLineItem {
  /** Id del producto (puede ser un hijo: el delta se aplica al padre). */
  item_id: number;
  /** Cantidad vendida/devuelta en la unidad de la línea. */
  quantity: number;
  /**
   * Override opcional del `value` de packaging. Si no llega, el helper lee el
   * packaging del producto y usa su `value` (o `1` si no tiene packaging).
   */
  packaging_value?: number | null;
  /**
   * FIX #3 — Receta CONGELADA del combo, si esta línea vende uno. Mismo molde
   * que `packaging_value`: si llega, manda sobre `combo_components`; si es
   * `null`/ausente (líneas legacy) se lee la receta vigente.
   *
   * Sin este override, editar la receta entre la venta y su anulación rompe la
   * simetría DEDUCT↔RETURN: quitar un componente pierde su stock para siempre y
   * subir una cantidad devuelve más de lo que se descontó.
   */
  combo_recipe?: ComboRecipeSnapshot | null;
}

/** Una fila de la receta congelada: qué componente y cuánto, en unidad mínima. */
export interface ComboRecipeSnapshotLine {
  component_product_id: number;
  quantity: number;
}

/**
 * Explosión congelada de un combo, tal cual se aplicó al comprometer las
 * unidades. Se persiste en la línea de venta / de nota y viaja hasta el
 * `RETURN` para que devuelva EXACTAMENTE lo que el `DEDUCT` descontó.
 */
export type ComboRecipeSnapshot = ComboRecipeSnapshotLine[];

/**
 * `DEDUCT` resta del stock (al confirmar una venta). `RETURN` suma al stock
 * (al anular una venta / generar NC con devolución).
 */
export type AdjustDirection = 'DEDUCT' | 'RETURN';

/**
 * Contexto del ajuste — guía para los inserts en `inventory_movements`.
 * Si se omite, el helper usa defaults conservadores (reason SALE/SALE_VOID
 * según direction; referenceType null).
 */
export interface AdjustInventoryContext {
  reason?: InventoryMovementReason;
  referenceType?: InventoryMovementReferenceType;
  referenceId?: number | null;
  referenceCode?: string | null;
  description?: string | null;
  /**
   * Si `true`, permite que un DEDUCT deje el stock negativo (operación
   * forzada por owner/superadmin). Si `false` o ausente, valida.
   */
  overrideStock?: boolean;
  actorName?: string | null;
  actorUserId?: number | null;
  /**
   * FASE 2 (COMPARTIR). Si `true`, el `companyId` recibido es la company ACTIVA
   * (p.ej. la sucursal que vende), pero los productos se resuelven en el set
   * ACCESIBLE (propios + compartidos por el principal). El stock se descuenta /
   * lockea / audita en la company DUEÑA REAL de cada producto (el principal para
   * un producto compartido), nunca en la activa. Sin esta bandera el helper
   * mantiene el comportamiento estricto por `company_id = companyId` (todas las
   * llamadas de compras/bulk/anulación quedan IDÉNTICAS).
   */
  crossCompanyAccess?: boolean;
}

const logger = new Logger('AdjustInventoryHelper');

interface ProductRef {
  id: number;
  parent_id: number | null;
  packaging_id: number | null;
  name: string;
  /** Company DUEÑA real del producto (donde vive su fila/stock). */
  owner_company_id: number;
  /** Un COMBO se expande en las líneas de su receta antes de calcular deltas. */
  product_type: ProductType;
}

/**
 * Error 422 cuando un DEDUCT dejaría el stock negativo sin override. Espejo
 * de `InsufficientStockError` de PlacePos. El controller lo traduce a
 * `{success:false, error, payload:{code:'INSUFFICIENT_STOCK'}}`.
 */
export class InsufficientStockError extends UnprocessableEntityException {
  constructor(productName: string, available: string, required: string) {
    super({
      message: `Stock insuficiente para ${productName}: disponible ${available}, requerido ${required}.`,
      payload: { code: 'INSUFFICIENT_STOCK', productName, available, required },
    });
  }
}

/**
 * Carga productos por id dentro de la company. Solo los campos necesarios.
 *
 * Modo ESTRICTO (default): filtra `company_id = companyId`; `owner_company_id`
 * de cada ref == companyId.
 *
 * Modo CROSS-COMPANY (`crossCompanyAccess`): resuelve en el set ACCESIBLE
 * (propios + compartidos por el principal) y captura el `owner_company_id` REAL
 * de cada producto (el principal para uno compartido).
 */
async function loadProductRefs(
  manager: EntityManager,
  companyId: number,
  itemIds: number[],
  crossCompanyAccess: boolean,
): Promise<Map<number, ProductRef>> {
  if (itemIds.length === 0) {
    return new Map();
  }
  const map = new Map<number, ProductRef>();

  if (crossCompanyAccess) {
    const accessible = await resolveAccessibleProducts(manager, companyId, itemIds);
    for (const ref of accessible.values()) {
      map.set(ref.id, {
        id: ref.id,
        parent_id: ref.parentId,
        packaging_id: ref.packagingId,
        name: ref.name,
        owner_company_id: ref.ownerCompanyId,
        product_type: (ref.productType as ProductType) ?? ProductType.SIMPLE,
      });
    }
    return map;
  }

  const rows = await manager.find(Product, {
    where: { id: In(itemIds.map(String)), company_id: String(companyId) },
    select: { id: true, parent_id: true, packaging_id: true, name: true, product_type: true },
  });
  for (const row of rows) {
    map.set(Number(row.id), {
      id: Number(row.id),
      parent_id: row.parent_id !== null ? Number(row.parent_id) : null,
      packaging_id: row.packaging_id !== null ? Number(row.packaging_id) : null,
      name: row.name,
      owner_company_id: companyId,
      product_type: row.product_type ?? ProductType.SIMPLE,
    });
  }
  return map;
}

/**
 * Explota las líneas cuyo producto es un COMBO en las líneas de sus componentes.
 * Espejo de `placepos/src/main/database/utils/inventoryUtils.ts`.
 *
 * La receta (`combo_components.quantity`) está en la unidad MÍNIMA del base, la
 * misma en la que vive `products.stock`. Por eso la línea expandida viaja con
 * `packaging_value: 1`: la cantidad ya está convertida y el motor no debe
 * volver a multiplicarla por el empaque del componente.
 *
 *   qty_componente = qty_combo × cantidad_receta
 *
 * El COMBO en sí NUNCA genera movimiento de inventario: no tiene stock propio,
 * desaparece de las líneas y en su lugar quedan sus bases. Un combo sin receta
 * (solo posible manipulando la BD: el alta exige ≥1 componente) simplemente no
 * descuenta nada, en vez de abortar la venta.
 *
 * La receta se lee en la company DUEÑA del combo (en cross-company, el
 * principal). La expansión es de UN nivel: un combo no puede ser componente de
 * otro combo (lo valida el alta/edición del combo).
 */
async function expandComboLines(
  manager: EntityManager,
  lines: InventoryLineItem[],
  productMap: Map<number, ProductRef>,
): Promise<InventoryLineItem[]> {
  const comboLines = lines.filter(
    (l) => productMap.get(l.item_id)?.product_type === ProductType.COMBO,
  );
  if (comboLines.length === 0) {
    return lines;
  }

  // FIX #3: solo se consulta `combo_components` para los combos SIN receta
  // congelada. Una venta reciente trae su snapshot y no toca la tabla.
  const staleRefs = [
    ...new Map(
      comboLines
        .filter((l) => !hasFrozenRecipe(l))
        .map((l) => productMap.get(l.item_id))
        .filter((ref): ref is ProductRef => ref !== undefined)
        .map((ref) => [ref.id, ref] as const),
    ).values(),
  ];

  const recipeByCombo = new Map<number, ComboRecipeSnapshot>();
  if (staleRefs.length > 0) {
    const rows = await manager.find(ComboComponent, {
      where: staleRefs.map((ref) => ({
        company_id: String(ref.owner_company_id),
        combo_product_id: String(ref.id),
      })),
      select: { combo_product_id: true, component_product_id: true, quantity: true },
    });
    for (const row of rows) {
      const key = Number(row.combo_product_id);
      const list = recipeByCombo.get(key) ?? [];
      list.push({
        component_product_id: Number(row.component_product_id),
        quantity: Number(row.quantity),
      });
      recipeByCombo.set(key, list);
    }
  }

  const expanded: InventoryLineItem[] = [];
  for (const line of lines) {
    if (productMap.get(line.item_id)?.product_type !== ProductType.COMBO) {
      expanded.push(line);
      continue;
    }
    // La receta congelada de la línea manda; sin ella, la vigente en la BD.
    const recipe = hasFrozenRecipe(line)
      ? (line.combo_recipe as ComboRecipeSnapshot)
      : (recipeByCombo.get(line.item_id) ?? []);
    for (const component of recipe) {
      expanded.push({
        item_id: Number(component.component_product_id),
        quantity: Number(
          new Big(line.quantity)
            .times(Number(component.quantity))
            .round(4, Big.roundHalfUp)
            .toString(),
        ),
        packaging_value: 1,
      });
    }
  }
  return expanded;
}

/**
 * Una receta congelada VACÍA (`[]`) no es lo mismo que ausente: significa "al
 * vender, este combo no tenía componentes", y debe devolver cero — no
 * reexpandirse contra la receta que exista hoy.
 */
function hasFrozenRecipe(line: InventoryLineItem): boolean {
  return Array.isArray(line.combo_recipe);
}

/**
 * Carga el `value` de cada packaging. En modo estricto filtra por `company_id`;
 * en modo cross-company los packagings de productos compartidos pertenecen al
 * principal, así que se cargan por id SIN filtro de company (el id ya proviene
 * de un producto accesible — no hay fuga cross-tenant: solo se resuelven los
 * packaging_id de productos que ya pasaron el filtro de accesibilidad).
 */
async function loadPackagingValues(
  manager: EntityManager,
  companyId: number,
  packagingIds: number[],
  crossCompanyAccess: boolean,
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (packagingIds.length === 0) {
    return map;
  }
  const rows = await manager.find(Packaging, {
    where: crossCompanyAccess
      ? { id: In(packagingIds.map(String)) }
      : { id: In(packagingIds.map(String)), company_id: String(companyId) },
    select: { id: true, value: true },
  });
  for (const pkg of rows) {
    const value = Number(pkg.value);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Packaging ${pkg.id} tiene valor inválido (${pkg.value}). No se puede ajustar inventario hasta corregirlo.`,
      );
    }
    map.set(Number(pkg.id), value);
  }
  return map;
}

/**
 * Resuelve productos parent que no estén ya cargados (el caller solo trajo
 * hijos, pero el delta vive en el padre).
 */
async function loadParentRefs(
  manager: EntityManager,
  companyId: number,
  productMap: Map<number, ProductRef>,
  crossCompanyAccess: boolean,
): Promise<void> {
  const parentIds = [
    ...new Set(
      Array.from(productMap.values())
        .map((p) => p.parent_id)
        .filter((id): id is number => id != null && !productMap.has(id)),
    ),
  ];
  if (parentIds.length === 0) {
    return;
  }
  const parents = await loadProductRefs(manager, companyId, parentIds, crossCompanyAccess);
  for (const [id, ref] of parents.entries()) {
    productMap.set(id, ref);
  }
}

/**
 * Calcula los deltas en la unidad base, agrupando por target = parent_id ?? id.
 * Regla unificada (espejo PlacePos):
 *   delta = qty × own_packaging_value
 */
function computeStockDeltas(
  lines: InventoryLineItem[],
  productMap: Map<number, ProductRef>,
  packagingMap: Map<number, number>,
): Map<number, Big> {
  const stockDeltas = new Map<number, Big>();
  for (const line of lines) {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new Error(`Cantidad inválida (${line.quantity}) para item_id=${line.item_id}.`);
    }
    const product = productMap.get(line.item_id);
    if (!product) {
      // 422 y no un Error pelado (500): pasa en cobro/anulación, con la
      // transacción a medias, y el cliente necesita un mensaje accionable.
      throw new UnprocessableEntityException(
        `El producto #${line.item_id} no está disponible en este negocio — no se puede ajustar inventario.`,
      );
    }
    const targetId = product.parent_id ?? product.id;
    const packagingValue =
      typeof line.packaging_value === 'number' && line.packaging_value > 0
        ? line.packaging_value
        : product.packaging_id
          ? (packagingMap.get(product.packaging_id) ?? 1)
          : 1;
    const unitsBig = new Big(line.quantity).times(packagingValue);
    const current = stockDeltas.get(targetId) ?? new Big(0);
    stockDeltas.set(targetId, current.plus(unitsBig));
  }
  return stockDeltas;
}

interface LockedTarget {
  id: number;
  name: string;
  stock: Big;
  /** Company DUEÑA real del producto destino (donde vive el stock). */
  ownerCompanyId: number;
}

/**
 * Lockea con pessimistic_write los productos destino y trae su stock actual.
 * Ordena ids ascendente para prevenir deadlocks entre transacciones que
 * lockean distintos subconjuntos en distinto orden.
 */
async function lockTargetProducts(
  manager: EntityManager,
  companyId: number,
  targetIds: number[],
  crossCompanyAccess: boolean,
): Promise<Map<number, LockedTarget>> {
  if (targetIds.length === 0) {
    return new Map();
  }
  const sortedIds = [...targetIds].sort((a, b) => a - b);
  // En modo cross-company el target puede ser del principal: lockeamos por id
  // sin filtro de company (los ids ya salieron del set accesible). En modo
  // estricto se mantiene el filtro `company_id = companyId`.
  const qb = manager
    .getRepository(Product)
    .createQueryBuilder('p')
    .setLock('pessimistic_write')
    .orderBy('p.id', 'ASC')
    .select(['p.id', 'p.name', 'p.stock', 'p.company_id']);
  if (crossCompanyAccess) {
    qb.where('p.id IN (:...ids)', { ids: sortedIds.map(String) });
  } else {
    qb.where('p.id IN (:...ids) AND p.company_id = :companyId', {
      ids: sortedIds.map(String),
      companyId: String(companyId),
    });
  }
  const rows = await qb.getMany();
  return new Map(
    rows.map((r) => [
      Number(r.id),
      {
        id: Number(r.id),
        name: r.name,
        stock: new Big(Number(r.stock)),
        ownerCompanyId: Number(r.company_id),
      },
    ]),
  );
}

/**
 * Default reason cuando el caller no especifica uno.
 */
function defaultReason(direction: AdjustDirection): InventoryMovementReason {
  return direction === 'DEDUCT' ? 'SALE' : 'SALE_VOID';
}

/**
 * Ajusta el stock de productos basado en líneas de venta/compra/devolución.
 *
 * - Lockea cada producto destino con pessimistic_write antes de leer stock.
 * - Si direction = DEDUCT y NO viene overrideStock, valida que el stock final
 *   no quede negativo. Lanza `InsufficientStockError` (422).
 * - Inserta una fila en `inventory_movements` por cada producto afectado,
 *   dentro de la misma transacción.
 *
 * El stock vive en la unidad mínima vendible (típicamente gramos para
 * a granel, unidades para producto unitario). Para cada línea aplica:
 *   delta = qty × own_packaging_value
 * sobre el padre si es un hijo o sobre el propio producto si es base.
 */
export async function adjustInventory(
  manager: EntityManager,
  companyId: number,
  lines: InventoryLineItem[],
  direction: AdjustDirection,
  ctx: AdjustInventoryContext = {},
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  const crossCompanyAccess = ctx.crossCompanyAccess === true;

  const itemIds = [...new Set(lines.map((l) => l.item_id))];
  const productMap = await loadProductRefs(manager, companyId, itemIds, crossCompanyAccess);

  // Los COMBO no tienen stock propio: se reemplazan por las líneas de sus
  // componentes ANTES de calcular deltas. Si no hay combos en la operación,
  // `effectiveLines === lines` y el camino queda idéntico al de siempre.
  const effectiveLines = await expandComboLines(manager, lines, productMap);
  if (effectiveLines.length === 0) {
    return;
  }
  const newIds = [
    ...new Set(effectiveLines.map((l) => l.item_id).filter((id) => !productMap.has(id))),
  ];
  for (const [id, ref] of (
    await loadProductRefs(manager, companyId, newIds, crossCompanyAccess)
  ).entries()) {
    productMap.set(id, ref);
  }

  // Si la operación solo trae hijos, sus padres no están en productMap todavía.
  await loadParentRefs(manager, companyId, productMap, crossCompanyAccess);

  const packagingIds = [
    ...new Set(
      Array.from(productMap.values())
        .filter((p) => p.packaging_id !== null)
        .map((p) => p.packaging_id as number),
    ),
  ];
  const packagingMap = await loadPackagingValues(
    manager,
    companyId,
    packagingIds,
    crossCompanyAccess,
  );

  const stockDeltas = computeStockDeltas(effectiveLines, productMap, packagingMap);
  if (stockDeltas.size === 0) {
    return;
  }

  const targetIds = Array.from(stockDeltas.keys());
  const locked = await lockTargetProducts(manager, companyId, targetIds, crossCompanyAccess);

  // Gating de validación: solo bloqueamos un DEDUCT cuando el comercio DUEÑO del
  // stock activó `strict_inventory_control`. En cross-company el dueño es el
  // principal; cacheamos el flag por owner para no consultarlo N veces.
  const strictByOwner = new Map<number, boolean>();
  const resolveStrict = async (ownerCompanyId: number): Promise<boolean> => {
    if (direction !== 'DEDUCT') {
      return false;
    }
    const cached = strictByOwner.get(ownerCompanyId);
    if (cached !== undefined) {
      return cached;
    }
    const value = await isStrictInventoryEnabled(manager, ownerCompanyId);
    strictByOwner.set(ownerCompanyId, value);
    return value;
  };

  const reason = ctx.reason ?? defaultReason(direction);
  const sign = direction === 'DEDUCT' ? -1 : 1;

  for (const [productId, deltaBig] of stockDeltas.entries()) {
    // numeric(15,4): redondeamos a 4 decimales con roundHalfUp para alinear
    // con la precisión de la columna. NUNCA Math.floor.
    const rounded = deltaBig.round(4, Big.roundHalfUp);
    if (rounded.eq(0)) {
      continue;
    }

    const target = locked.get(productId);
    if (!target) {
      throw new Error(`No se pudo lockear el producto #${productId} para ajustar inventario.`);
    }

    // El stock se descuenta y audita en la company DUEÑA del producto (en
    // cross-company, el principal). En modo estricto coincide con `companyId`.
    const ownerCompanyId = target.ownerCompanyId;
    const strict = await resolveStrict(ownerCompanyId);

    const stockBefore = target.stock;
    const change = rounded.times(sign);
    const stockAfter = stockBefore.plus(change).round(4, Big.roundHalfUp);

    if (strict && direction === 'DEDUCT' && !ctx.overrideStock && stockAfter.lt(0)) {
      throw new InsufficientStockError(target.name, stockBefore.toString(), rounded.toString());
    }

    await manager.update(
      Product,
      { id: String(productId), company_id: String(ownerCompanyId) },
      { stock: stockAfter.toNumber() },
    );

    await recordInventoryMovement(manager, {
      companyId: ownerCompanyId,
      productId,
      direction: direction === 'DEDUCT' ? 'OUT' : 'IN',
      quantity: rounded.toNumber(),
      stockBefore: stockBefore.toNumber(),
      stockAfter: stockAfter.toNumber(),
      reason,
      referenceType: ctx.referenceType ?? null,
      referenceId: ctx.referenceId ?? null,
      referenceCode: ctx.referenceCode ?? null,
      description: ctx.description ?? null,
      createdBy: ctx.actorName ?? null,
      createdById: ctx.actorUserId ?? null,
    });
  }

  logger.debug({
    event: 'inventory.adjust.applied',
    companyId,
    direction,
    reason,
    lineCount: lines.length,
    targetCount: stockDeltas.size,
  });
}

/**
 * Lee el flag global `strict_inventory_control` (per-company) desde la tabla
 * `app_settings`. Default `false` si la row no existe — paridad placepos
 * (`inventorySettings.service.ts → isStrictInventoryEnabled`).
 *
 * Multi-tenant: filtra siempre por `company_id`.
 */
async function isStrictInventoryEnabled(
  manager: EntityManager,
  companyId: number,
): Promise<boolean> {
  const row = await manager.findOne(AppSetting, {
    where: {
      company_id: String(companyId),
      key: APP_SETTING_KEYS.STRICT_INVENTORY_CONTROL,
    },
  });
  return row?.value === 'true';
}

/**
 * Inserta una fila de auditoría en `inventory_movements`. Debe invocarse
 * DENTRO de la misma transacción que muta `Product.stock`. Quantity siempre
 * positivo: el signo lo lleva `direction`.
 */
export async function recordInventoryMovement(
  manager: EntityManager,
  args: {
    companyId: number;
    productId: number;
    direction: InventoryMovementDirection;
    quantity: number;
    stockBefore: number;
    stockAfter: number;
    reason: InventoryMovementReason;
    referenceType: InventoryMovementReferenceType;
    referenceId: number | null;
    referenceCode: string | null;
    description: string | null;
    createdBy: string | null;
    createdById: number | null;
  },
): Promise<void> {
  if (args.quantity <= 0) {
    return;
  }
  await manager.insert(InventoryMovement, {
    company_id: String(args.companyId),
    product_id: String(args.productId),
    direction: args.direction,
    quantity: args.quantity,
    reason: args.reason,
    stock_before: args.stockBefore,
    stock_after: args.stockAfter,
    reference_type: args.referenceType,
    reference_id: args.referenceId !== null ? String(args.referenceId) : null,
    reference_code: args.referenceCode,
    description: args.description,
    created_by: args.createdBy,
    created_by_id: args.createdById !== null ? String(args.createdById) : null,
  });
}
