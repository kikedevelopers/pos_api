import type { EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { SaleCredit } from '../entities/sale-credit.entity';
import { SalePayment } from '../entities/sale-payment.entity';

/**
 * Estado de COBRO de una venta: cuánto dinero real ha entrado y si nació como
 * crédito.
 *
 * Lo consume la edición de ventas (NC/ND) para decidir si la corrección mueve
 * dinero. Un CRÉDITO SIN ABONOS no ha recibido ni un peso: una NC no tiene qué
 * devolver y una ND no cobra nada en el momento — ambas solo cambian lo que el
 * cliente debe. Con al menos un abono (o una venta de contado) la corrección
 * sí mueve dinero y se pide la cuenta origen/destino.
 */
export interface SaleCollectionState {
  /** Σ(amount − change_amount) de los pagos VIVOS de la venta. */
  paid_amount: number;
  /** true si la venta tiene `SaleCredit` (nació como crédito). */
  has_credit: boolean;
  /** true si es crédito y no ha recibido ningún abono (`paid_amount = 0`). */
  is_unpaid_credit: boolean;
}

export async function getSaleCollectionState(
  manager: EntityManager,
  companyId: number,
  saleId: number,
  credit?: SaleCredit | null,
): Promise<SaleCollectionState> {
  const resolvedCredit =
    credit !== undefined
      ? credit
      : await manager.findOne(SaleCredit, {
          where: { company_id: String(companyId), sale_invoice_id: String(saleId) },
          select: { id: true },
        });

  const payments = await manager.find(SalePayment, {
    where: {
      company_id: String(companyId),
      sale_invoice_id: String(saleId),
      is_voided: false,
    },
    select: { id: true, amount: true, change_amount: true },
  });
  const paidBig = payments.reduce(
    (acc, p) => acc.plus(toBig(p.amount).minus(toBig(p.change_amount ?? 0))),
    toBig(0),
  );
  const paid_amount = paidBig.lt(0) ? 0 : preciseNumber(paidBig, 2);
  const has_credit = resolvedCredit !== null;

  return {
    paid_amount,
    has_credit,
    is_unpaid_credit: has_credit && paid_amount === 0,
  };
}
