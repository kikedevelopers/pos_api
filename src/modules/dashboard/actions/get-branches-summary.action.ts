import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import { todayUtc } from '../internal/date-range';
import { GetTodayAction } from './get-today.action';

/**
 * Resumen consolidado por sucursal para el owner multi-sucursal.
 *
 * Una fila por cada company del owner (negocio principal + sucursales ACTIVAS)
 * con las mismas cifras del "Resumen de ventas del día" (base DEVENGADO):
 *   - `sales`    = ventas del día (contado + crédito devengado + pedidos) = `TodayResult.totalSales`.
 *   - `profit`   = ganancia devengada del día = `TodayResult.salesProfit`.
 *   - `margin`   = `profit / sales * 100`.
 *   - `expenses` = gastos variables del día = `TodayResult.expenses`.
 *   - `total`    = `sales - expenses` (fórmula pedida: Venta − Gastos).
 *
 * La fila `totals` suma cada columna; `margin` se recalcula sobre los totales
 * (`sumProfit / sumSales`), no como promedio de márgenes.
 *
 * Paridad: cada fila se calcula invocando `GetTodayAction.execute(companyId)`,
 * EXACTAMENTE la misma maquinaria que alimenta la card del dashboard, así que
 * una sucursal cuadra al centavo con lo que vería parándose en ella.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy / autorización
 * --------------------------------------------------------------------------
 *
 * Solo se consultan companies de las que el `userId` (owner) es miembro en
 * `company_members`. No se acepta `companyId` por parámetro: se derivan del
 * owner, así que un owner nunca puede ver datos de otro (anti-IDOR). El negocio
 * principal (`is_branch = false`) va SIEMPRE; las sucursales solo si están
 * activas (`company_members.is_active = true`).
 */

export interface BranchSummaryRow {
  companyId: number;
  name: string;
  isBranch: boolean;
  sales: number;
  profit: number;
  margin: number;
  expenses: number;
  /** Venta − Gastos. */
  total: number;
}

export interface BranchesSummaryResult {
  date: string;
  rows: BranchSummaryRow[];
  totals: {
    sales: number;
    profit: number;
    margin: number;
    expenses: number;
    total: number;
  };
}

interface OwnerCompanyRow {
  id: string;
  name: string;
  is_branch: boolean;
  is_active: boolean;
}

const round2 = (n: unknown): number => Number(toBig(n).round(2).toString());

@Injectable()
export class GetBranchesSummaryAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly getToday: GetTodayAction,
  ) {}

  async execute(userId: number, dateInput?: string): Promise<BranchesSummaryResult> {
    const targetDate = dateInput ?? todayUtc();

    // Companies del owner: principal (is_branch=false) primero, luego sucursales
    // por id. Fuente de verdad de la pertenencia: company_members.
    const companies = await this.dataSource.query<OwnerCompanyRow[]>(
      `
      SELECT c.id, c.name, c.is_branch, cm.is_active
      FROM company_members cm
      INNER JOIN companies c ON c.id = cm.company_id
      WHERE cm.user_id = $1
      ORDER BY c.is_branch ASC, c.id ASC
      `,
      [String(userId)],
    );

    // Principal SIEMPRE + sucursales ACTIVAS. Una sucursal suspendida no aparece.
    const selected = companies.filter((c) => !c.is_branch || c.is_active);

    const rows: BranchSummaryRow[] = await Promise.all(
      selected.map(async (c) => {
        const today = await this.getToday.execute(Number(c.id), targetDate);
        const sales = round2(today.totalSales);
        const profit = round2(today.salesProfit);
        const expenses = round2(today.expenses);
        const margin = sales > 0 ? round2(toBig(profit).div(sales).times(100).toNumber()) : 0;
        const total = round2(toBig(sales).minus(toBig(expenses)).toNumber());
        return {
          companyId: Number(c.id),
          name: c.name,
          isBranch: c.is_branch,
          sales,
          profit,
          margin,
          expenses,
          total,
        };
      }),
    );

    const sumSales = round2(
      rows.reduce((acc, r) => acc.plus(toBig(r.sales)), toBig(0)).toNumber(),
    );
    const sumProfit = round2(
      rows.reduce((acc, r) => acc.plus(toBig(r.profit)), toBig(0)).toNumber(),
    );
    const sumExpenses = round2(
      rows.reduce((acc, r) => acc.plus(toBig(r.expenses)), toBig(0)).toNumber(),
    );
    const sumTotal = round2(toBig(sumSales).minus(toBig(sumExpenses)).toNumber());
    const totalMargin =
      sumSales > 0 ? round2(toBig(sumProfit).div(sumSales).times(100).toNumber()) : 0;

    return {
      date: targetDate,
      rows,
      totals: {
        sales: sumSales,
        profit: sumProfit,
        margin: totalMargin,
        expenses: sumExpenses,
        total: sumTotal,
      },
    };
  }
}
