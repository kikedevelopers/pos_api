import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';
import { round2 } from '@/modules/dashboard/internal/aggregations';

import type {
  ComparativeGranularity,
  ComparativeReportQueryDto,
} from '../dto/comparative-report-query.dto';
import {
  fetchDayMetricsMap,
  sumRangeTotals,
  type DayMetrics,
  type RangeTotals,
} from '../internal/comparative-metrics';
import {
  addDaysUtc,
  buildSubBuckets,
  computeCurrentStart,
  computePreviousStart,
  concretePeriodLabel,
  diffDays,
  formatDateOnlyUtc,
  naturalPeriodEnd,
} from '../internal/comparative-periods';

interface GrowthBlock {
  salesPct: number | null;
  salesDelta: number;
  profitPct: number | null;
  profitDelta: number;
  marginDelta: number;
}

interface PeriodBlock {
  label: string;
  from: string;
  to: string;
  sales: number;
  cost: number;
  profit: number;
  margin: number;
  growth: GrowthBlock | null;
}

interface BreakdownCell {
  from: string;
  to: string;
  sales: number;
  cost: number;
  profit: number;
  margin: number;
  growth: GrowthBlock | null;
}

interface BreakdownEntry {
  label: string;
  periods: BreakdownCell[];
}

export interface ComparativeReportResult {
  granularity: ComparativeGranularity;
  reference: string;
  count: number;
  offset: number;
  toDate: boolean;
  canGoForward: boolean;
  periods: PeriodBlock[];
  breakdown: BreakdownEntry[];
}

/** Período resuelto (inicio/fin como Date UTC) + sus mapas de métricas por-día. */
interface ResolvedPeriod {
  start: Date;
  end: Date;
  dayMap: Map<string, DayMetrics>;
}

const ZERO_TOTALS: RangeTotals = { sales: 0, cost: 0, profit: 0, margin: 0 };

/**
 * `GET /pos-reports/comparative` (v2). Informe Comparativo con navegación de
 * períodos: muestra hasta 3 períodos consecutivos (ANTIGUO→NUEVO) con
 * crecimiento encadenado y un breakdown por sub-buckets alineados.
 *
 * Las métricas por-día se calculan con la MISMA lógica que
 * `GET /dashboard/performance` (ver `comparative-metrics.ts`) para que los
 * números coincidan con el dashboard cloud ya validado.
 *
 * Multi-tenancy: `companyId` se propaga a todos los helpers de `aggregations`,
 * que parametrizan `company_id = $1` en cada subquery.
 */
@Injectable()
export class GetComparativeReportAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    query: ComparativeReportQueryDto,
  ): Promise<ComparativeReportResult> {
    const granularity: ComparativeGranularity = query.granularity ?? 'monthly';
    const reference = query.reference ?? new Date().toISOString().slice(0, 10);
    const count = query.count ?? 2;
    const offset = query.offset ?? 0;
    const toDate = offset === 0;

    const refDate = new Date(`${reference}T00:00:00.000Z`);

    // start[0] = inicio del período ACTUAL; start[k] = anterior iterado k veces.
    // Necesitamos índices desde 0 hasta (offset + count - 1) para cubrir la ventana.
    const maxIndex = offset + count - 1;
    const starts: Date[] = [computeCurrentStart(reference, granularity)];
    for (let k = 1; k <= maxIndex; k += 1) {
      starts.push(computePreviousStart(starts[k - 1], granularity));
    }

    // Ventana "a la fecha": si toDate, la longitud es (ref - start[0]); todos los
    // períodos mostrados comparten esa longitud. Si offset>0, cada período usa
    // su fin natural (período completo).
    const windowDays = diffDays(starts[0], refDate);

    // Índices mostrados ANTIGUO→NUEVO: desde (offset+count-1) hasta offset.
    const shownIndices: number[] = [];
    for (let idx = offset + count - 1; idx >= offset; idx -= 1) {
      shownIndices.push(idx);
    }

    // Resolvemos cada período mostrado (inicio, fin) y consultamos su mapa por-día.
    const resolved: ResolvedPeriod[] = await Promise.all(
      shownIndices.map(async (idx) => {
        const start = starts[idx];
        const end = toDate ? addDaysUtc(start, windowDays) : naturalPeriodEnd(start, granularity);
        // Los límites del rango son días CALENDARIO colombianos (America/Bogota):
        // `fetchDayMetricsMap` agrupa las ventas por `TO_CHAR(... AT TIME ZONE
        // 'America/Bogota')`, así que si construyéramos el rango en UTC-medianoche
        // una venta de la tarde-noche (p.ej. 22:00 Col = 03:00Z del día siguiente)
        // caería fuera del rango pero SÍ dentro de su día colombiano → descuadre.
        // `dayjs.tz(... , Bogota).toDate()` da el instante UTC de la medianoche
        // colombiana, alineando las claves de día del dayMap con el rango.
        const dateStart = dayjs
          .tz(`${formatDateOnlyUtc(start)} 00:00:00.000`, APP_TIMEZONE)
          .toDate();
        const dateEnd = dayjs.tz(`${formatDateOnlyUtc(end)} 23:59:59.999`, APP_TIMEZONE).toDate();
        const dayMap = await fetchDayMetricsMap(this.dataSource, companyId, dateStart, dateEnd);
        return { start, end, dayMap };
      }),
    );

    // Totales por período + growth encadenado (periods[0]=null base).
    const periodTotals: RangeTotals[] = resolved.map((p) =>
      sumRangeTotals(p.dayMap, this.dateRange(p.start, p.end)),
    );

    const periods: PeriodBlock[] = resolved.map((p, i) => {
      const totals = periodTotals[i];
      const growth = i === 0 ? null : this.computeGrowth(totals, periodTotals[i - 1]);
      return {
        label: concretePeriodLabel(granularity, p.start),
        from: formatDateOnlyUtc(p.start),
        to: formatDateOnlyUtc(p.end),
        ...totals,
        growth,
      };
    });

    // Sub-buckets definidos sobre el período mostrado MÁS LARGO (cubre todos los
    // días de todos los períodos). elapsedDays = (end - start) de ese período.
    const longest = resolved.reduce((acc, p) =>
      diffDays(p.start, p.end) > diffDays(acc.start, acc.end) ? p : acc,
    );
    const longestElapsed = diffDays(longest.start, longest.end);
    const subBuckets = buildSubBuckets(granularity, longest.start, longestElapsed);

    const breakdown: BreakdownEntry[] = subBuckets.map((bucket) => {
      const cellTotals: RangeTotals[] = resolved.map((p) => {
        const subStart = addDaysUtc(p.start, bucket.offsetStart);
        // Si el inicio del sub-bucket cae fuera del período → métricas en 0.
        if (subStart.getTime() > p.end.getTime()) {
          return ZERO_TOTALS;
        }
        const subEndCandidate = addDaysUtc(p.start, bucket.offsetEnd);
        const subEnd = subEndCandidate.getTime() > p.end.getTime() ? p.end : subEndCandidate;
        return sumRangeTotals(p.dayMap, this.dateRange(subStart, subEnd));
      });

      const cells: BreakdownCell[] = resolved.map((p, i) => {
        const subStart = addDaysUtc(p.start, bucket.offsetStart);
        const subEndCandidate = addDaysUtc(p.start, bucket.offsetEnd);
        const clampedEnd = subEndCandidate.getTime() > p.end.getTime() ? p.end : subEndCandidate;
        const inRange = subStart.getTime() <= p.end.getTime();
        const growth = i === 0 ? null : this.computeGrowth(cellTotals[i], cellTotals[i - 1]);
        return {
          from: formatDateOnlyUtc(inRange ? subStart : addDaysUtc(p.start, bucket.offsetStart)),
          to: formatDateOnlyUtc(inRange ? clampedEnd : addDaysUtc(p.start, bucket.offsetEnd)),
          ...cellTotals[i],
          growth,
        };
      });

      return { label: bucket.label, periods: cells };
    });

    return {
      granularity,
      reference,
      count,
      offset,
      toDate,
      canGoForward: offset > 0,
      periods,
      breakdown,
    };
  }

  /** Lista de fechas `YYYY-MM-DD` inclusiva entre `start` y `end` (UTC). */
  private dateRange(start: Date, end: Date): string[] {
    const total = diffDays(start, end);
    const dates: string[] = [];
    for (let offset = 0; offset <= total; offset += 1) {
      dates.push(formatDateOnlyUtc(addDaysUtc(start, offset)));
    }
    return dates;
  }

  /**
   * growth: salesPct=(cur-prev)/prev*100 (null si prev==0); salesDelta=cur-prev;
   * profit análogo; marginDelta=cur.margin-prev.margin (puntos). round2.
   */
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
