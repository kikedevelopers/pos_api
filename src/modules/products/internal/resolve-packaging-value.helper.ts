import { In, type EntityManager } from 'typeorm';

import { Packaging } from '@/modules/packagings/entities/packaging.entity';

import { resolveAccessibleProducts } from './accessible-products.helper';
import { Product } from '../entities/product.entity';

/**
 * FIX #2 (snapshot de packaging) — Resuelve, para un conjunto de `item_id`, el
 * factor de conversión del empaque vigente del producto:
 *
 *   packaging_value = product.packaging_id ? packagings.value : 1
 *
 * Se usa para CONGELAR el factor en la línea (`sale_invoice_lines` /
 * `credit_note_lines`) al crear la venta y al emitir la ND por edición, de modo
 * que el `DEDUCT` y su `RETURN` posterior usen el MISMO factor (simetría).
 *
 * --------------------------------------------------------------------------
 * Snapshot TOLERANTE (no estricto)
 * --------------------------------------------------------------------------
 *
 * Este helper SOLO calcula el snapshot; NUNCA lanza. Si un producto no se
 * resuelve, o su packaging no existe / tiene `value` inválido (<= 0 o no
 * finito), se OMITE del Map → el caller persiste `packaging_value = null` y el
 * motor (`adjustInventory`) cae a su fallback. El guard ESTRICTO (que sí lanza
 * por packaging inválido) vive solo en el camino real de ajuste, no aquí:
 * snapshot tolerante, ajuste real estricto.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy / transacción
 * --------------------------------------------------------------------------
 *
 * - DEBE ejecutarse DENTRO de la transacción del caller (recibe su `manager`).
 * - `crossCompanyAccess = false` (default): filtro ESTRICTO por `company_id`
 *   (solo productos propios).
 * - `crossCompanyAccess = true`: resuelve el set ACCESIBLE (propios +
 *   compartidos por el principal) reutilizando `resolveAccessibleProducts` —
 *   el MISMO criterio que usa el motor con `crossCompanyAccess`. Así el catálogo
 *   COMPARTIDO también queda con su `packaging_value` congelado y se preserva la
 *   simetría DEDUCT↔RETURN aunque el principal edite el `value` del empaque. Los
 *   packagings de productos compartidos viven en el principal, así que en este
 *   modo se cargan por id SIN filtro de company (los ids ya provienen de
 *   productos accesibles → sin fuga cross-tenant).
 *
 * @returns `Map<item_id, packaging_value>` solo con los productos resueltos con
 *          packaging válido (o factor 1 si no tienen empaque).
 */
export async function resolvePackagingValues(
  manager: EntityManager,
  companyId: number,
  itemIds: number[],
  crossCompanyAccess = false,
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const uniqueIds = [...new Set(itemIds.map((id) => Number(id)))];
  if (uniqueIds.length === 0) {
    return result;
  }

  // item_id → packaging_id (null si el producto no tiene empaque). Solo entran
  // los productos efectivamente resueltos (propios, o accesibles en cross).
  const packagingIdByItem = new Map<number, number | null>();
  if (crossCompanyAccess) {
    const accessible = await resolveAccessibleProducts(manager, companyId, uniqueIds);
    for (const ref of accessible.values()) {
      packagingIdByItem.set(ref.id, ref.packagingId);
    }
  } else {
    const products = await manager.find(Product, {
      where: { id: In(uniqueIds.map(String)), company_id: String(companyId) },
      select: { id: true, packaging_id: true },
    });
    for (const p of products) {
      packagingIdByItem.set(Number(p.id), p.packaging_id !== null ? Number(p.packaging_id) : null);
    }
  }

  const packagingIds = [
    ...new Set([...packagingIdByItem.values()].filter((id): id is number => id !== null)),
  ];

  const packagingValueById = new Map<number, number>();
  if (packagingIds.length > 0) {
    const packagings = await manager.find(Packaging, {
      where: crossCompanyAccess
        ? { id: In(packagingIds.map(String)) }
        : { id: In(packagingIds.map(String)), company_id: String(companyId) },
      select: { id: true, value: true },
    });
    for (const pkg of packagings) {
      const value = Number(pkg.value);
      // TOLERANTE: un packaging inválido NO se registra → el producto queda sin
      // snapshot (null) y el motor decide con su fallback/guard estricto.
      if (Number.isFinite(value) && value > 0) {
        packagingValueById.set(Number(pkg.id), value);
      }
    }
  }

  for (const [productId, packagingId] of packagingIdByItem.entries()) {
    if (packagingId === null) {
      // Producto base / sin empaque → factor 1 (unidad mínima = unidad de venta).
      result.set(productId, 1);
      continue;
    }
    const value = packagingValueById.get(packagingId);
    if (value !== undefined) {
      result.set(productId, value);
    }
    // else: packaging ausente/inválido → omitido → caller persiste null.
  }

  return result;
}
