import { Logger, UnprocessableEntityException } from '@nestjs/common';
import Big from 'big.js';
import { In, type EntityManager } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '@/modules/app-settings/entities/app-setting.entity';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';

import {
  InventoryMovement,
  type InventoryMovementDirection,
  type InventoryMovementReason,
  type InventoryMovementReferenceType,
} from '../entities/inventory-movement.entity';
import { Product } from '../entities/product.entity';

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
}

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
      });
    }
    return map;
  }

  const rows = await manager.find(Product, {
    where: { id: In(itemIds.map(String)), company_id: String(companyId) },
    select: { id: true, parent_id: true, packaging_id: true, name: true },
  });
  for (const row of rows) {
    map.set(Number(row.id), {
      id: Number(row.id),
      parent_id: row.parent_id !== null ? Number(row.parent_id) : null,
      packaging_id: row.packaging_id !== null ? Number(row.packaging_id) : null,
      name: row.name,
      owner_company_id: companyId,
    });
  }
  return map;
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
      throw new Error(
        `El producto #${line.item_id} no existe en la company — no se puede ajustar inventario.`,
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

  const stockDeltas = computeStockDeltas(lines, productMap, packagingMap);
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
