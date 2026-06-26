import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { round2 } from '@/modules/dashboard/internal/aggregations';
import { parseDateRange } from '@/modules/dashboard/internal/date-range';

import type { ComparativeByDayQueryDto } from '../dto/comparative-by-day-query.dto';
import {
  fetchDayMetricsMap,
  sumRangeTotals,
  type RangeTotals,
} from '../internal/comparative-metrics';
import { formatDateOnlyUtc, parseDateOnlyUtc } from '../internal/comparative-periods';

interface GrowthBlock {
  salesPct: number | null;
  salesDelta: number;
  profitPct: number | null;
  profitDelta: number;
  marginDelta: number;
}

interface DayPeriodBlock {
  label: string;
  date: string;
  /** Día del mes solicitado (1..31). */
  requestedDay: number;
  /** true si el mes no tenía ese día y se usó el último. */
  clamped: boolean;
  sales: number;
  cost: number;
  profit: number;
  margin: number;
  growth: GrowthBlock | null;
}

export interface ComparativeByDayResult {
  reference: string;
  day: number;
  count: number;
  periods: DayPeriodBlock[];
}

const MONTH_ABBR_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

/**
 * `GET /pos-reports/comparative/by-day`. Compara el MISMO día del mes (ej. 26)
 * entre el mes de referencia y los (count-1) meses anteriores. Si un mes es más
 * corto que el día pedido se usa su último día (clamped). Growth encadenado
 * ANTIGUO→NUEVO. Métricas con la MISMA fuente que el comparativo por período
 * (paridad con PlacePos offline).
 */
@Injectable()
export class GetComparativeByDayReportAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    query: ComparativeByDayQueryDto,
  ): Promise<ComparativeByDayResult> {
    const reference = query.reference ?? new Date().toISOString().slice(0, 10);
    const count = query.count ?? 2;
    const refDate = parseDateOnlyUtc(reference);
    const day = query.day ?? refDate.getUTCDate();

    // Fechas ANTIGUO→NUEVO: el más viejo es (count-1) meses atrás.
    const targets = Array.from({ length: count }, (_, i) =>
      this.resolveDayDate(refDate, day, count - 1 - i),
    );

    // Una consulta de 1 día por mes, en paralelo. El rango se acota en hora
    // COLOMBIA (parseDateRange) — igual que el dashboard — para que "el día 26"
    // sean las ventas del 26 calendario colombiano (no UTC, que perdería la
    // franja nocturna). fetchDayMetricsMap agrupa por Bogota, así que todas las
    // filas del rango caen en `ymd`.
    const totals: RangeTotals[] = await Promise.all(
      targets.map(async ({ date }) => {
        const ymd = formatDateOnlyUtc(date);
        const { dateStart, dateEnd } = parseDateRange(ymd, ymd);
        const dayMap = await fetchDayMetricsMap(this.dataSource, companyId, dateStart, dateEnd);
        return sumRangeTotals(dayMap, [ymd]);
      }),
    );

    const periods: DayPeriodBlock[] = targets.map(({ date, clamped }, i) => {
      const growth = i === 0 ? null : this.computeGrowth(totals[i], totals[i - 1]);
      return {
        label: `${date.getUTCDate()} ${MONTH_ABBR_ES[date.getUTCMonth()]} ${date.getUTCFullYear()}`,
        date: formatDateOnlyUtc(date),
        requestedDay: day,
        clamped,
        ...totals[i],
        growth,
      };
    });

    return { reference, day, count, periods };
  }

  /**
   * Fecha real (clamped) del día `day` para el mes `monthsBack` atrás respecto
   * del mes de `ref`. Date.UTC normaliza índices de mes negativos a años previos.
   */
  private resolveDayDate(
    ref: Date,
    day: number,
    monthsBack: number,
  ): { date: Date; clamped: boolean } {
    const monthStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - monthsBack, 1));
    const y = monthStart.getUTCFullYear();
    const m = monthStart.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const resolved = Math.min(day, daysInMonth);
    return { date: new Date(Date.UTC(y, m, resolved)), clamped: resolved !== day };
  }

  /** Idéntico al de `GetComparativeReportAction` (paridad de fórmula). */
  private computeGrowth(cur: RangeTotals, prev: RangeTotals): GrowthBlock {
    const curSales = new Big(cur.sales);
    const prevSales = new Big(prev.sales);
    const curProfit = new Big(cur.profit);
    const prevProfit = new Big(prev.profit);

    const salesDelta = round2(curSales.minus(prevSales).toNumber());
    const profitDelta = round2(curProfit.minus(prevProfit).toNumber());
    const marginDelta = round2(new Big(cur.margin).minus(new Big(prev.margin)).toNumber());

    const salesPct = prevSales.eq(0)
      ? null
      : round2(curSales.minus(prevSales).times(100).div(prevSales).toNumber());
    const profitPct = prevProfit.eq(0)
      ? null
      : round2(curProfit.minus(prevProfit).times(100).div(prevProfit).toNumber());

    return { salesPct, salesDelta, profitPct, profitDelta, marginDelta };
  }
}
