import type Big from 'big.js';
import type { EntityManager } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import {
  getCustomerPointsConfig,
  pointsForAmount,
} from '@/modules/app-settings/internal/customer-points-config';
import { CreditNote, NoteType } from '@/modules/credit-notes/entities/credit-note.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';

import { SaleCredit } from '../entities/sale-credit.entity';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';

/**
 * Σ(credit_notes.total) de la venta para un `note_type` dado, dentro de la
 * company. Filtra `is_deleted = false` — una nota anulada no consolida.
 */
const sumNotes = async (
  manager: EntityManager,
  saleInvoiceId: string,
  companyId: number,
  noteType: NoteType,
): Promise<Big> => {
  const row = await manager
    .createQueryBuilder(CreditNote, 'cn')
    .select('COALESCE(SUM(cn.total), 0)', 'sum')
    .where('cn.sale_invoice_id = :saleInvoiceId', { saleInvoiceId })
    .andWhere('cn.company_id = :companyId', { companyId: String(companyId) })
    .andWhere('cn.note_type = :noteType', { noteType })
    .andWhere('cn.is_deleted = false')
    .getRawOne<{ sum: string }>();
  return toBig(row?.sum ?? 0);
};

/**
 * Total consolidado de la venta = `total − Σ(CREDIT) + Σ(DEBIT)`. Big.js en
 * todo el cálculo. Espejo de `computeConsolidatedTotal` de PlacePos.
 */
const computeConsolidatedTotal = async (
  manager: EntityManager,
  invoice: Pick<SaleInvoice, 'id' | 'total'>,
  companyId: number,
): Promise<Big> => {
  const credit = await sumNotes(manager, invoice.id, companyId, NoteType.CREDIT);
  const debit = await sumNotes(manager, invoice.id, companyId, NoteType.DEBIT);
  return toBig(invoice.total).minus(credit).plus(debit);
};

/**
 * Principal a crédito de la venta (`SaleCredit.total_amount`), 0 si la venta no
 * dejó saldo a crédito. En pos_api `SaleCredit` se enlaza por `sale_invoice_id`
 * y vive en la misma company.
 */
const getCreditPrincipal = async (
  manager: EntityManager,
  saleInvoiceId: string,
  companyId: number,
): Promise<Big> => {
  const credit = await manager.getRepository(SaleCredit).findOne({
    where: { sale_invoice_id: saleInvoiceId, company_id: String(companyId) },
    select: ['total_amount'],
  });
  return credit ? toBig(credit.total_amount) : toBig(0);
};

/**
 * Aplica el `delta` (puede ser negativo) al saldo de puntos del cliente sin
 * permitir negativos (`GREATEST(points + delta, 0)`). Filtra por company —
 * cross-tenant guard.
 */
const applyCustomerDelta = async (
  manager: EntityManager,
  customerId: string,
  companyId: number,
  delta: number,
): Promise<void> => {
  await manager
    .createQueryBuilder()
    .update(Customer)
    .set({ points: () => 'GREATEST("points" + :delta, 0)' })
    .where('id = :customerId', { customerId })
    .andWhere('company_id = :companyId', { companyId: String(companyId) })
    .setParameters({ delta })
    .execute();
};

/**
 * Modelo RECOMPUTE idempotente de los puntos de una venta — espejo de
 * `placepos/src/main/database/customerPointsOperations.ts → recomputeSalePoints`.
 *
 * Recalcula los puntos que la venta DEBERÍA otorgar según su estado actual
 * (`total + notas − crédito`) y ajusta el saldo del cliente por el DELTA contra
 * lo ya otorgado (`points_awarded`). Idempotente: llamarlo N veces converge al
 * mismo saldo. Solo acumulación de CONTADO (la parte a crédito se excluye con
 * `creditPrincipal`). El canje queda FUERA de alcance.
 *
 * NO abre transacción propia: usa el `manager` del caller (que ya corre en
 * SERIALIZABLE con los locks correspondientes). Bails out temprano si:
 *   - la venta no existe en la company.
 *   - la venta no está constituida (`ticket_type !== SALE`).
 *   - la config de puntos no está habilitada.
 *   - la venta no tiene `customer_id`.
 *
 * `oldCustomerId` (opcional): cliente que TENÍA la venta antes de una edición que
 * cambió el cliente. Si difiere del actual, primero se le revierten los puntos
 * ya otorgados por esta venta (y se pone `points_awarded = 0`) para que el nuevo
 * cliente los reciba completos. Espejo del mismo parámetro en placepos.
 *
 * @param manager        EntityManager de la transacción del caller.
 * @param saleInvoiceId  ID de la venta (number).
 * @param companyId      Tenant activo.
 * @param oldCustomerId  Cliente anterior si hubo cambio de cliente (opcional).
 */
export async function recomputeSalePoints(
  manager: EntityManager,
  saleInvoiceId: number,
  companyId: number,
  oldCustomerId?: string | null,
): Promise<void> {
  const invoice = await manager.getRepository(SaleInvoice).findOne({
    where: { id: String(saleInvoiceId), company_id: String(companyId) },
    select: ['id', 'customer_id', 'total', 'ticket_type', 'points_awarded'],
  });
  if (!invoice) {
    return;
  }
  if (invoice.ticket_type !== TicketType.SALE) {
    return;
  }

  const cfg = await getCustomerPointsConfig(manager, companyId);
  if (!cfg.enabled) {
    return;
  }

  // Cambio de cliente: revertir lo otorgado al cliente anterior antes de
  // recalcular para el nuevo. Solo cuando realmente difieren.
  let awardedBaseline = invoice.points_awarded;
  if (
    oldCustomerId !== undefined &&
    oldCustomerId !== null &&
    oldCustomerId !== invoice.customer_id &&
    invoice.points_awarded !== 0
  ) {
    await applyCustomerDelta(manager, oldCustomerId, companyId, -invoice.points_awarded);
    await manager
      .getRepository(SaleInvoice)
      .update({ id: invoice.id, company_id: String(companyId) }, { points_awarded: 0 });
    awardedBaseline = 0;
  }

  if (invoice.customer_id === null) {
    return;
  }

  const totalConsolidado = await computeConsolidatedTotal(manager, invoice, companyId);
  const creditPrincipal = await getCreditPrincipal(manager, invoice.id, companyId);
  const baseBig = totalConsolidado.minus(creditPrincipal);
  const base = baseBig.gt(0) ? baseBig.toNumber() : 0;

  const newAwarded = pointsForAmount(base, cfg);
  const delta = newAwarded - awardedBaseline;
  if (delta === 0) {
    return;
  }

  await applyCustomerDelta(manager, invoice.customer_id, companyId, delta);
  await manager
    .getRepository(SaleInvoice)
    .update({ id: invoice.id, company_id: String(companyId) }, { points_awarded: newAwarded });
}
