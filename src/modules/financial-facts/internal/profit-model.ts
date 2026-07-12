import Big from 'big.js';

import { preciseNumber, toBig } from '@/common/utils/precision';

/**
 * Lógica PURA de utilidad (sin SQL). Fuente única de las fórmulas de ganancia
 * del contrato canónico (`../contracts/metrics-spec.md`). Reutilizada por
 * pos_api y replicada byte-a-byte en placepos (`src/main/financial/profit-model.ts`).
 *
 * Dos modelos de utilidad, según el eje temporal:
 *   - DEVENGADA (`computeRealizedProfit`): se reconoce al vender, sobre la
 *     columna `si.profit`, ajustada por notas. Es la "Ganancia del día" headline.
 *   - COBRADA (`computeAbonoProfitProportional` + contado prorrateado): porción
 *     de utilidad dentro del recaudo; abonos por modelo PROPORCIONAL. Métrica
 *     aparte (bloque de cartera).
 */

/** Totales de notas de ajuste (CREDIT resta utilidad, DEBIT la suma). */
export interface NoteTotals {
  creditTotal: number;
  creditCost: number;
  debitTotal: number;
  debitCost: number;
}

/**
 * Ajuste de UTILIDAD por notas: una ND suma su utilidad (`total − cost`) y una
 * NC la resta. Devuelve un `Big` (sin redondear) para encadenar.
 */
export function noteProfitAdjustment(notes: NoteTotals): Big {
  const debitProfit = toBig(notes.debitTotal).minus(toBig(notes.debitCost));
  const creditProfit = toBig(notes.creditTotal).minus(toBig(notes.creditCost));
  return debitProfit.minus(creditProfit);
}

/**
 * Ajuste de VENTAS por notas: ND suma su total, NC lo resta. `Big` sin redondear.
 */
export function noteRevenueAdjustment(notes: NoteTotals): Big {
  return toBig(notes.debitTotal).minus(toBig(notes.creditTotal));
}

/**
 * Ganancia DEVENGADA del rango (headline "Ganancia del día"):
 * `SUM(si.profit)` de todas las ventas realizadas + ajuste de notas.
 * Redondeada a escala monetaria (2).
 */
export function computeRealizedProfit(baseProfit: unknown, notes: NoteTotals): number {
  return preciseNumber(toBig(baseProfit).plus(noteProfitAdjustment(notes)), 2);
}

/** Fila de un abono con su factura consolidada (total/cost ya netos de notas). */
export interface AbonoRow {
  amountPaid: number;
  consolidatedTotal: number;
  consolidatedCost: number;
}

/**
 * Utilidad COBRADA de abonos a crédito por modelo PROPORCIONAL: cada abono
 * aporta `effective · profit/total`, con `effective = min(pago, total)`.
 * Preserva la identidad `recaudo = costo + ganancia`. Ignora facturas con
 * `total ≤ 0`. Redondeada a 2.
 */
export function computeAbonoProfitProportional(rows: AbonoRow[]): number {
  let acc = new Big(0);
  for (const row of rows) {
    const total = toBig(row.consolidatedTotal);
    if (total.lte(0)) {
      continue;
    }
    const profit = total.minus(toBig(row.consolidatedCost));
    const paid = toBig(row.amountPaid);
    const effective = paid.lt(total) ? paid : total;
    acc = acc.plus(effective.times(profit).div(total));
  }
  return preciseNumber(acc, 2);
}
