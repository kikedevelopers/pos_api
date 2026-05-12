import type { EntityManager } from 'typeorm';

import { Purchase } from '../entities/purchase.entity';
import { PurchasePayment } from '../entities/purchase-payment.entity';

/**
 * Generación de folios per-company. Solución PROVISIONAL mientras
 * `TicketSetting` (Fase 10) no exista.
 *
 * --------------------------------------------------------------------------
 * Algoritmo
 * --------------------------------------------------------------------------
 *
 *   1. Adquirimos `pg_advisory_xact_lock(hashtext('purchases_<companyId>'))`
 *      DENTRO de la transacción. El lock se libera automáticamente al
 *      commit/rollback. Sólo serializa con otra transacción que pida el
 *      MISMO lock; no bloquea lectores.
 *
 *   2. SELECT `MAX(purchase_number)` filtrado por company_id. El parsing
 *      del último número se hace por regex porque el folio es texto
 *      (`PUR-001`).
 *
 *   3. `next = max + 1`. Formato `PUR-${padStart(3,'0')}`.
 *
 *   4. INSERT. El UNIQUE composite `(company_id, purchase_number)` es la
 *      red de seguridad por si dos transacciones bypass del lock (otro
 *      proceso fuera de NestJS).
 *
 * Mismo patrón para `payment_number` con prefijo `ABO-`.
 *
 * --------------------------------------------------------------------------
 * TODO(Fase 10)
 * --------------------------------------------------------------------------
 *
 * Reemplazar por:
 *   UPDATE ticket_settings
 *      SET current_number = current_number + 1, updated_at = now()
 *    WHERE company_id = $1 AND ticket_type = 'PURCHASE'
 *    RETURNING current_number, prefix;
 *
 * Atómico, idéntico al patrón de PlacePos. El advisory lock se elimina.
 */

const PURCHASE_PREFIX = 'PUR';
const PAYMENT_PREFIX = 'ABO';

/**
 * Adquiere advisory lock per-company para serializar la generación de
 * folios. Sale automáticamente al commit/rollback.
 */
async function lockNumberingForCompany(
  manager: EntityManager,
  companyId: number,
  scope: 'purchase' | 'payment',
): Promise<void> {
  // hashtext es deterministic → mismo scope+companyId → mismo lock id.
  // Se usa hashtext porque pg_advisory_xact_lock acepta bigint y nuestro
  // identificador combinado es texto.
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${scope}_${companyId}`]);
}

/**
 * Extrae el sufijo numérico de un folio `PREFIX-NNN`. Devuelve 0 si el
 * folio no matchea (defensivo — nunca debería pasar pero evita crash).
 */
function extractSuffix(formatted: string, prefix: string): number {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const match = re.exec(formatted);
  if (!match) {
    return 0;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

/**
 * Devuelve el siguiente `purchase_number` para una company, DENTRO de la
 * transacción del caller.
 */
export async function nextPurchaseNumber(
  manager: EntityManager,
  companyId: number,
): Promise<string> {
  await lockNumberingForCompany(manager, companyId, 'purchase');

  const rows =
    (await manager
      .createQueryBuilder(Purchase, 'p')
      .select('p.purchase_number', 'purchase_number')
      .where('p.company_id = :companyId', { companyId: String(companyId) })
      .orderBy('p.id', 'DESC')
      .limit(1)
      .getRawOne<{ purchase_number: string }>()) ?? null;

  const lastSuffix = rows ? extractSuffix(rows.purchase_number, PURCHASE_PREFIX) : 0;
  return formatNumber(PURCHASE_PREFIX, lastSuffix + 1);
}

/**
 * Devuelve el siguiente `payment_number` para una company, DENTRO de la
 * transacción del caller.
 */
export async function nextPaymentNumber(
  manager: EntityManager,
  companyId: number,
): Promise<string> {
  await lockNumberingForCompany(manager, companyId, 'payment');

  const rows =
    (await manager
      .createQueryBuilder(PurchasePayment, 'pp')
      .select('pp.payment_number', 'payment_number')
      .where('pp.company_id = :companyId', { companyId: String(companyId) })
      .orderBy('pp.id', 'DESC')
      .limit(1)
      .getRawOne<{ payment_number: string }>()) ?? null;

  const lastSuffix = rows ? extractSuffix(rows.payment_number, PAYMENT_PREFIX) : 0;
  return formatNumber(PAYMENT_PREFIX, lastSuffix + 1);
}
