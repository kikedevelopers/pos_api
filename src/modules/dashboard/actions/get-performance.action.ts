import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import {
  fetchCreditsGeneratedByDay,
  fetchExpensesByDay,
  fetchNotesByDay,
  fetchSalesByDay,
  round2,
} from '../internal/aggregations';
import { buildDateList, daysAgoUtc, parseDateRange, todayUtc } from '../internal/date-range';
import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import { fetchOrdersByDay } from '@/modules/reports/internal/sales-aggregations';

/**
 * Output del endpoint `GET /dashboard/performance`. Series temporales + totales.
 *
 * Convención PlacePos: cada punto preserva la identidad `sales = cost + profit`
 * post-consolidación. Los `credits` son los créditos GENERADOS en ese día
 * (Pasivos), separados del recaudo.
 */
export interface PerformancePoint {
  date: string;
  sales: number;
  profit: number;
  expenses: number;
  credits: number;
  /**
   * Facturación de pedidos del día (flag `include_orders_in_reports`; 0 con el
   * flag OFF). YA ESTÁ SUMADA dentro de `sales` (el pedido se trata como una
   * venta normal) y su ganancia dentro de `profit`; se expone aparte solo para
   * poder discriminar qué parte de `sales` viene de pedidos.
   */
  orders: number;
}

export interface PerformanceTotals {
  sales: number;
  profit: number;
  expenses: number;
  credits: number;
  orders: number;
  margin: number;
}

export interface PerformanceResult {
  from: string;
  to: string;
  series: PerformancePoint[];
  totals: PerformanceTotals;
}

/**
 * `GET /dashboard/performance?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Espejo PlacePos: ventas, ganancia y gastos por día, con consolidación
 * proporcional de notas y abonos a créditos.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * Cada helper en `aggregations.ts` parametriza `company_id = $1` en TODAS sus
 * subqueries. La action solo recibe `companyId` y lo propaga. No hay queries
 * "globales" sin filtro de tenant.
 */
@Injectable()
export class GetPerformanceAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly getIncludeOrdersInReports: GetIncludeOrdersInReportsAction,
  ) {}

  async execute(
    companyId: number,
    fromInput?: string,
    toInput?: string,
  ): Promise<PerformanceResult> {
    const fromStr = fromInput ?? daysAgoUtc(6);
    const toStr = toInput ?? todayUtc();
    const range = parseDateRange(fromStr, toStr);

    // Flag `include_orders_in_reports`: con él activo el pedido cuenta como una
    // venta normal — suma a la serie "Recaudo" y su ganancia a "Ganancia",
    // igual que en el resto del dashboard.
    const includeOrders = await this.getIncludeOrdersInReports.execute(companyId);

    // Paralelizamos los reads — son SELECTs independientes contra la misma DB.
    const [salesRows, notesRows, expensesRows, creditsGeneratedRows, ordersRows] =
      await Promise.all([
        // Ventas DEVENGADAS: incluyen el crédito por su valor íntegro el día de la
        // venta (una venta a crédito es una venta). NO se suma el share de abonos
        // (base caja) para no doble-contar. Los créditos generados van en la serie
        // discriminada `credits`.
        fetchSalesByDay(this.dataSource, companyId, range.dateStart, range.dateEnd, true),
        fetchNotesByDay(this.dataSource, companyId, range.dateStart, range.dateEnd, true),
        fetchExpensesByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
        fetchCreditsGeneratedByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
        includeOrders.enabled
          ? fetchOrdersByDay(this.dataSource, String(companyId), range.dateStart, range.dateEnd)
          : Promise.resolve([]),
      ]);

    interface Bucket {
      sales: Big;
      profit: Big;
      cost: Big;
      expenses: Big;
      credits: Big;
      orders: Big;
    }
    const byDate = new Map<string, Bucket>();
    const ensure = (date: string): Bucket => {
      const existing = byDate.get(date);
      if (existing) {
        return existing;
      }
      const fresh: Bucket = {
        sales: new Big(0),
        profit: new Big(0),
        cost: new Big(0),
        expenses: new Big(0),
        credits: new Big(0),
        orders: new Big(0),
      };
      byDate.set(date, fresh);
      return fresh;
    };

    for (const row of salesRows) {
      const b = ensure(row.date);
      b.sales = b.sales.plus(toBig(row.sales));
      b.profit = b.profit.plus(toBig(row.profit));
      b.cost = b.cost.plus(toBig(row.cost));
    }

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

    for (const row of expensesRows) {
      const b = ensure(row.date);
      b.expenses = b.expenses.plus(toBig(row.expenses));
    }

    for (const row of creditsGeneratedRows) {
      const b = ensure(row.date);
      b.credits = b.credits.plus(toBig(row.credits));
    }

    // Pedidos (flag ON): se tratan como una venta normal — su total suma a
    // `sales` y su ganancia real (total − costo) a `profit`. `orders` guarda
    // aparte cuánto de `sales` viene de pedidos, para poder discriminarlo.
    for (const row of ordersRows) {
      const b = ensure(row.date);
      const ordersTotal = toBig(row.orders_total);
      const ordersCost = toBig(row.orders_cost);
      b.orders = b.orders.plus(ordersTotal);
      b.sales = b.sales.plus(ordersTotal);
      b.cost = b.cost.plus(ordersCost);
      b.profit = b.profit.plus(ordersTotal.minus(ordersCost));
    }

    const series: PerformancePoint[] = buildDateList(range.from, range.to).map((date) => {
      const b = byDate.get(date);
      return {
        date,
        sales: round2(b ? b.sales.toNumber() : 0),
        profit: round2(b ? b.profit.toNumber() : 0),
        expenses: round2(b ? b.expenses.toNumber() : 0),
        credits: round2(b ? b.credits.toNumber() : 0),
        orders: round2(b ? b.orders.toNumber() : 0),
      };
    });

    // Totales: agregamos sobre `series` (ya redondeado) para que `totals = Σ
    // series`. PlacePos hace lo mismo; alinea los gráficos con el resumen.
    const totals = series.reduce(
      (acc, d) => {
        acc.sales = acc.sales.plus(d.sales);
        acc.profit = acc.profit.plus(d.profit);
        acc.expenses = acc.expenses.plus(d.expenses);
        acc.credits = acc.credits.plus(d.credits);
        acc.orders = acc.orders.plus(d.orders);
        return acc;
      },
      {
        sales: new Big(0),
        profit: new Big(0),
        expenses: new Big(0),
        credits: new Big(0),
        orders: new Big(0),
      },
    );

    const salesTotal = round2(totals.sales.toNumber());
    const profitTotal = round2(totals.profit.toNumber());
    const ordersTotal = round2(totals.orders.toNumber());
    // `sales` ya incluye los pedidos, así que numerador y denominador son
    // coherentes y la fórmula del margen no cambia con el flag.
    const margin = totals.sales.gt(0)
      ? round2(totals.profit.times(100).div(totals.sales).toNumber())
      : 0;

    return {
      from: range.from,
      to: range.to,
      series,
      totals: {
        sales: salesTotal,
        profit: profitTotal,
        expenses: round2(totals.expenses.toNumber()),
        credits: round2(totals.credits.toNumber()),
        orders: ordersTotal,
        margin,
      },
    };
  }
}
