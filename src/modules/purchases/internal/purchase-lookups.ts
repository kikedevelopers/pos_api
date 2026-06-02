import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { CarrierCredit } from '@/modules/carriers/entities/carrier-credit.entity';
import { Carrier } from '@/modules/carriers/entities/carrier.entity';

import { PurchaseCredit } from '../entities/purchase-credit.entity';
import { PurchaseLine } from '../entities/purchase-line.entity';
import { PurchasePayment } from '../entities/purchase-payment.entity';
import { Purchase } from '../entities/purchase.entity';

/**
 * Helpers internos del módulo `purchases`. Centralizan la lectura del
 * agregado (purchase + líneas + credit + payments) dentro de la company.
 *
 * Diseño:
 *   - Cada función recibe `EntityManager` para reutilizarse tanto en read
 *     puro (Repo.manager) como en transacciones (manager del transaction).
 *   - Lanza `NotFoundException` si la purchase no existe o pertenece a otra
 *     company — anti-enumeración cross-tenant.
 */

/**
 * Lookup por id dentro de una company. NO filtra `is_deleted` por defecto
 * (mutaciones de pagos/recepción pueden requerir trabajar sobre la cabecera
 * aunque haya sido soft-deleted; el caller decide).
 *
 * Si `requireActive = true`, se exige `is_deleted = false` — usado en
 * listados públicos y en validaciones de "no se puede pagar una compra
 * anulada".
 */
export async function findPurchaseInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { requireActive?: boolean } = {},
): Promise<Purchase> {
  const where: { id: string; company_id: string; is_deleted?: boolean } = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.requireActive === true) {
    where.is_deleted = false;
  }

  const purchase = await manager.findOne(Purchase, { where });
  if (!purchase) {
    throw new NotFoundException('Compra no encontrada');
  }
  return purchase;
}

/**
 * Carga las líneas de una compra, filtradas por `company_id` para defensa
 * en profundidad (la denormalización debería garantizarlo, pero el filtro
 * explícito previene fugas si en el futuro cambia el modelo).
 */
export async function findPurchaseLines(
  manager: EntityManager,
  purchaseId: number,
  companyId: number,
): Promise<PurchaseLine[]> {
  return manager.find(PurchaseLine, {
    where: { purchase_id: String(purchaseId), company_id: String(companyId) },
    order: { id: 'ASC' },
  });
}

/**
 * Carga el `PurchaseCredit` asociado a una compra, si existe. Devuelve
 * `null` cuando todavía no se ha generado (no debería ocurrir post-creación,
 * pero el método es robusto frente a estados inconsistentes).
 */
export async function findPurchaseCredit(
  manager: EntityManager,
  purchaseId: number,
  companyId: number,
): Promise<PurchaseCredit | null> {
  return manager.findOne(PurchaseCredit, {
    where: { purchase_id: String(purchaseId), company_id: String(companyId) },
  });
}

/**
 * Lista los pagos de una compra ordenados por fecha ascendente (para
 * mostrar historial cronológico en el frontend).
 */
export async function findPurchasePayments(
  manager: EntityManager,
  purchaseId: number,
  companyId: number,
): Promise<PurchasePayment[]> {
  return manager.find(PurchasePayment, {
    where: { purchase_id: String(purchaseId), company_id: String(companyId) },
    order: { created_at: 'ASC' },
  });
}

/**
 * Carga el transportista (snapshot) asociado a la compra por `carrier_id`.
 * `null` si la compra no tiene carrier. Multi-tenant por `company_id`.
 */
export async function findPurchaseCarrier(
  manager: EntityManager,
  carrierId: number | null,
  companyId: number,
): Promise<Carrier | null> {
  if (carrierId === null) {
    return null;
  }
  return manager.findOne(Carrier, {
    where: { id: String(carrierId), company_id: String(companyId) },
  });
}

/**
 * Carga el `CarrierCredit` (deuda al transportista) de una compra, si existe.
 * El frontend lo usa para el estado/saldo del flete en la sección Transporte.
 */
export async function findPurchaseCarrierCredit(
  manager: EntityManager,
  purchaseId: number,
  companyId: number,
): Promise<CarrierCredit | null> {
  return manager.findOne(CarrierCredit, {
    where: { purchase_id: String(purchaseId), company_id: String(companyId) },
  });
}
