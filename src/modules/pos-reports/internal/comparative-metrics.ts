import Big from 'big.js';
import type { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import {
  fetchCreditPaymentsBreakdownByDay,
  fetchNotesByDay,
  fetchSalesByDay,
  round2,
} from '@/modules/dashboard/internal/aggregations';

/**
 * Métricas por-día del Informe Comparativo. FUENTE DE VERDAD = misma lógica de
 * `GET /dashboard/performance` (`get-performance.action.ts`): se combinan
 * `fetchSalesByDay` + `fetchNotesByDay` + `fetchCreditPaymentsBreakdownByDay`
 * exactamente igual, para que los totales coincidan con el dashboard cloud ya
 * validado por el usuario.
 *
 * A diferencia de performance, NO incluimos `expenses` ni `credits` generados:
 * el comparativo solo expone ventas/costo/ganancia/margen. La combinación de
 * sales/cost/profit es byte-idéntica a performance.
 */

export interface DayMetrics {
  sales: Big;
  cost: Big;
  profit: Big;
}

export interface RangeTotals {
  sales: number;
  cost: number;
  profit: number;
  margin: number;
}

/**
 * Obtiene los buckets por-día (`YYYY-MM-DD` → DayMetrics) para `[dateStart,
 * dateEnd]`, consolidando notas y abonos a crédito igual que performance.
 *
 * Se consulta UNA sola vez por un rango grande (el que cubre prev+cur) y luego
 * se suma sobre sub-rangos en memoria, evitando re-consultar.
 */
export async function fetchDayMetricsMap(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<Map<string, DayMetrics>> {
  const [salesRows, notesRows, creditPaymentRows] = await Promise.all([
    fetchSalesByDay(dataSource, companyId, dateStart, dateEnd),
    fetchNotesByDay(dataSource, companyId, dateStart, dateEnd),
    fetchCreditPaymentsBreakdownByDay(dataSource, companyId, dateStart, dateEnd),
  ]);

  const byDate = new Map<string, DayMetrics>();
  const ensure = (date: string): DayMetrics => {
    const existing = byDate.get(date);
    if (existing) {
      return existing;
    }
    const fresh: DayMetrics = { sales: new Big(0), cost: new Big(0), profit: new Big(0) };
    byDate.set(date, fresh);
    return fresh;
  };

  // 1. Ventas regulares (excl. créditos).
  for (const row of salesRows) {
    const b = ensure(row.date);
    b.sales = b.sales.plus(toBig(row.sales));
    b.cost = b.cost.plus(toBig(row.cost));
    b.profit = b.profit.plus(toBig(row.profit));
  }

  // 2. Notas: CREDIT resta, DEBIT suma (idéntico a performance).
  for (const row of notesRows) {
    const b = ensure(row.date);
    const notesTotal = toBig(row.notes_total);
    const notesCost = toBig(row.notes_cost);
    const notesProfit = notesTotal.minus(notesCost);
    if (row.note_type === 'CREDIT') {
      b.sales = b.sales.minus(notesTotal);
      b.cost = b.cost.minus(notesCost);
      b.profit = b.profit.minus(notesProfit);
    } else {
      b.sales = b.sales.plus(notesTotal);
      b.cost = b.cost.plus(notesCost);
      b.profit = b.profit.plus(notesProfit);
    }
  }

  // 3. Share proporcional de abonos a invoices a crédito.
  for (const row of creditPaymentRows) {
    const b = ensure(row.date);
    b.sales = b.sales.plus(toBig(row.sales_share));
    b.cost = b.cost.plus(toBig(row.cost_share));
    b.profit = b.profit.plus(toBig(row.profit_share));
  }

  return byDate;
}

/**
 * Suma los buckets por-día de la lista `dates` (cada uno `YYYY-MM-DD`) y produce
 * los totales redondeados a 2 decimales. `margin = sales>0 ? profit/sales*100 : 0`.
 *
 * Espejo de performance: agregamos los valores YA redondeados por día para que
 * `total = Σ días redondeados` (alinea con el resumen del dashboard).
 */
export function sumRangeTotals(dayMap: Map<string, DayMetrics>, dates: string[]): RangeTotals {
  let sales = new Big(0);
  let cost = new Big(0);
  let profit = new Big(0);

  for (const date of dates) {
    const b = dayMap.get(date);
    sales = sales.plus(round2(b ? b.sales.toNumber() : 0));
    cost = cost.plus(round2(b ? b.cost.toNumber() : 0));
    profit = profit.plus(round2(b ? b.profit.toNumber() : 0));
  }

  const salesNum = round2(sales.toNumber());
  const margin = sales.gt(0) ? round2(profit.times(100).div(sales).toNumber()) : 0;

  return {
    sales: salesNum,
    cost: round2(cost.toNumber()),
    profit: round2(profit.toNumber()),
    margin,
  };
}
