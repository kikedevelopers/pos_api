import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { SaleCredit, SaleCreditStatus } from '../entities/sale-credit.entity';
import { SaleInvoice } from '../entities/sale-invoice.entity';
import { SalePayment } from '../entities/sale-payment.entity';

/**
 * Modelo RECOMPUTE del estado de cobro de una venta — espejo placepos de la
 * feature "eliminar/reversar un pago de venta" + "re-cobro de saldo".
 *
 * --------------------------------------------------------------------------
 * Qué hace
 * --------------------------------------------------------------------------
 *
 * Tras cualquier mutación de pagos (reverso o re-cobro), recomputa el estado
 * de cobro de la venta DESDE CERO sumando los pagos VIVOS (is_voided = false):
 *
 *   paid    = Σ (amount − change_amount)   de pagos vivos de la venta
 *   total   = sale.total
 *   balance = max(0, total − paid)
 *   status  = PENDING        si paid = 0
 *             PARTIALLY_PAID  si 0 < paid < total
 *             PAID            si balance = 0
 *
 * Es self-healing (no acumula deriva) y respeta los CHECK de `sale_credits`
 * (`paid_amount + balance = total_amount`, status↔montos).
 *
 * --------------------------------------------------------------------------
 * Efecto sobre SaleCredit
 * --------------------------------------------------------------------------
 *
 * REGLA DE NEGOCIO: una venta constituida NUNCA pasa a crédito por reversar un
 * pago. Solo es crédito si nació como crédito (ya tiene SaleCredit). Por eso:
 *   - Si existe SaleCredit → UPDATE (total_amount, paid_amount, balance, status).
 *   - Si NO existe → NUNCA se crea, tenga o no customer_id. Si queda saldo, la
 *     venta permanece SALE con saldo derivado (pendiente por cobrar /
 *     re-cobrable); si no queda saldo, es no-op (venta pagada).
 *
 * --------------------------------------------------------------------------
 * Customer.balance
 * --------------------------------------------------------------------------
 *
 * NO se toca `Customer.balance` aquí — paridad placepos (la cartera se deriva
 * de SaleCredit, no se acumula en el cliente). Esto es coherente con
 * `processCreditPayment` (que tampoco lo mueve). Difiere de
 * `createSaleCredit` en `create-sale.action`, que SÍ lo decrementa al crear
 * el crédito en el flujo de venta nueva; esa asimetría se preserva
 * deliberadamente para no descuadrar (ver reporte adjunto a la tarea).
 *
 * El caller DEBE haber tomado lock pessimistic_write sobre la venta y sobre
 * el SaleCredit (si existe) antes de invocar.
 */

export interface SaleSettlement {
  /** Σ(amount − change_amount) de pagos vivos. */
  paid: number;
  /** sale.total. */
  total: number;
  /** max(0, total − paid). */
  balance: number;
  /** Estado de cobro derivado. */
  status: SaleCreditStatus;
  /** true si la venta quedó con saldo pendiente. */
  isPending: boolean;
  /** id del SaleCredit afectado/creado, o null si la venta no tiene crédito. */
  creditId: number | null;
}

/**
 * Suma el neto (amount − change_amount) de los pagos VIVOS de una venta.
 * Big.js para no perder centavos.
 */
export function sumLivePayments(payments: SalePayment[]): number {
  const sum = payments
    .filter((p) => !p.is_voided)
    .reduce((acc, p) => acc.plus(toBig(p.amount).minus(toBig(p.change_amount ?? 0))), toBig(0));
  return preciseNumber(sum, 2);
}

/**
 * Recomputa y persiste el estado de cobro de la venta. Devuelve el settlement.
 *
 * @param manager   EntityManager de la transacción del caller (ya con locks).
 * @param sale      Venta (cabecera) ya lockeada.
 * @param companyId Tenant.
 * @param existingCredit SaleCredit ya lockeado (o null si no existe).
 */
export async function recomputeSaleSettlement(
  manager: EntityManager,
  sale: SaleInvoice,
  companyId: number,
  existingCredit: SaleCredit | null,
): Promise<SaleSettlement> {
  // 1. Sumar pagos vivos de la venta (re-leídos para reflejar la mutación que
  //    el caller acaba de hacer dentro de la misma transacción).
  const livePayments = await manager.find(SalePayment, {
    where: {
      sale_invoice_id: sale.id,
      company_id: String(companyId),
      is_voided: false,
    },
  });

  const totalBig = toBig(sale.total);
  const paidBig = livePayments.reduce(
    (acc, p) => acc.plus(toBig(p.amount).minus(toBig(p.change_amount ?? 0))),
    toBig(0),
  );

  // Clamp a [0, total] para respetar los CHECK de sale_credits.
  const paidClampedBig = paidBig.lt(0) ? toBig(0) : paidBig.gt(totalBig) ? totalBig : paidBig;
  const balanceBig = totalBig.minus(paidClampedBig);

  const paid = preciseNumber(paidClampedBig, 2);
  const total = preciseNumber(totalBig, 2);
  const balance = Math.max(0, preciseNumber(balanceBig, 2));

  const status: SaleCreditStatus =
    balance <= 0
      ? SaleCreditStatus.PAID
      : paid <= 0
        ? SaleCreditStatus.PENDING
        : SaleCreditStatus.PARTIALLY_PAID;

  const isPending = balance > 0;

  // 2. Persistir en SaleCredit.
  let creditId: number | null = existingCredit ? Number(existingCredit.id) : null;

  if (existingCredit) {
    await manager.update(
      SaleCredit,
      { id: existingCredit.id, company_id: String(companyId) },
      {
        total_amount: total,
        paid_amount: paid,
        balance,
        status,
      },
    );
  }
  // NO hay crédito → NUNCA se crea, tenga o no customer_id. Una venta solo es
  // crédito si nació como crédito. Si quedó saldo, la venta permanece SALE con
  // saldo derivado (pendiente por cobrar / re-cobrable); si no quedó saldo, es
  // no-op (venta pagada). Paridad placepos.

  return { paid, total, balance, status, isPending, creditId };
}

/**
 * Carga la venta con lock pessimistic_write para mutar sus pagos. Exige que
 * sea una SALE NO anulada. Reusa la convención de `findSaleInCompany` pero con
 * mensajes de la feature de reverso/re-cobro.
 */
export async function loadSaleForSettlement(
  manager: EntityManager,
  saleId: number,
  companyId: number,
): Promise<SaleInvoice> {
  const sale = await manager.findOne(SaleInvoice, {
    where: { id: String(saleId), company_id: String(companyId) },
    lock: { mode: 'pessimistic_write' },
  });
  if (!sale) {
    throw new NotFoundException('Venta no encontrada');
  }
  if (sale.is_deleted) {
    throw new UnprocessableEntityException({
      message: 'La venta está anulada; no se pueden modificar sus pagos.',
      payload: { code: 'SALE_VOIDED' },
    });
  }
  return sale;
}
