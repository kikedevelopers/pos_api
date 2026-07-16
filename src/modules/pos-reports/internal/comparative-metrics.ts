import Big from 'big.js';
import type { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import {
  fetchNotesByDay,
  fetchSalesByDay,
  round2,
} from '@/modules/dashboard/internal/aggregations';

/**
 * Métricas por-día del Informe Comparativo. Base **DEVENGADA**: una venta a
 * crédito es una venta más, así que suma su valor y ganancia ÍNTEGROS el día en
 * que se hace (`COALESCE(sold_at, created_at)`), igual que una de contado.
 *
 * Ventas/costo/ganancia = TODAS las ventas del día (contado + crédito,
 * `fetchSalesByDay(..., includeCredit=true)`) netas de notas
 * (`fetchNotesByDay(..., includeCredit=true)`). **NO** se suma el share de
 * abonos: en base devengada el crédito ya se reconoce al vender, así que
 * contarlo también al cobrarse lo doble-contaría. (El dashboard de recaudo sí
 * usa el share de abonos porque su base es caja.)
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
  const [salesRows, notesRows] = await Promise.all([
    fetchSalesByDay(dataSource, companyId, dateStart, dateEnd, true),
    fetchNotesByDay(dataSource, companyId, dateStart, dateEnd, true),
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

  // 1. Ventas del día (contado + crédito), por su valor íntegro devengado.
  for (const row of salesRows) {
    const b = ensure(row.date);
    b.sales = b.sales.plus(toBig(row.sales));
    b.cost = b.cost.plus(toBig(row.cost));
    b.profit = b.profit.plus(toBig(row.profit));
  }

  // 2. Notas (sobre todas las ventas, incl. crédito): CREDIT resta, DEBIT suma.
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

  // (Sin paso de abonos: en base devengada el crédito ya se reconoció al vender.)
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
