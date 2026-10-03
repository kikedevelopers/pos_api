import { ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  PERMISSION_KEYS,
  type PermissionKey,
} from '@/modules/roles/internal/permission-catalog';
import {
  ResolveEffectivePermissionsAction,
  type PermissionActor,
} from '@/modules/roles/actions/resolve-effective-permissions.action';

import { toBig } from '@/common/utils/precision';

import { todayUtcDate } from '../internal/range';
import { GetDailyClosureAction, type DailyClosureResult } from './get-daily-closure.action';

/**
 * `GET /reports/branches-daily-closure?date=YYYY-MM-DD`.
 *
 * Resumen del día de TODAS las sucursales del negocio, para el admin del
 * negocio PRINCIPAL. Por cada company (principal + sucursales activas) devuelve
 * su `DailyClosureResult` COMPLETO (idéntico al "Resumen del día" de esa
 * company, al centavo, porque reusa `GetDailyClosureAction`), más un bloque
 * `totals` con el consolidado (venta, ganancia, recaudo, créditos, gastos,
 * cartera) sumando todas las companies.
 *
 * --------------------------------------------------------------------------
 * Autorización / multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   - SOLO NIVEL ADMIN: owner/superadmin, o un empleado cuyo rol tenga TODAS
 *     las `PERMISSION_KEYS` (= rol de fábrica "Administrador"). Un Cajero
 *     (que sí tiene `canAccessDailyClosureReport`) NO entra. Se valida
 *     resolviendo los permisos efectivos del actor.
 *   - SOLO desde el negocio PRINCIPAL (`companies.is_branch = false`). Si la
 *     company actual es una sucursal → 403 (el admin de una sucursal no ve el
 *     consolidado del grupo).
 *   - Las companies se derivan del OWNER del negocio principal vía
 *     `company_members` (no de parámetros): un negocio nunca ve datos de otro.
 */

export interface BranchDailyClosure {
  companyId: number;
  name: string;
  isBranch: boolean;
  closure: DailyClosureResult;
}

/**
 * Consolidado de todas las companies. Los montos son SUMA directa; los
 * márgenes se recalculan sobre los agregados (no se promedian).
 */
export interface BranchesClosureTotals {
  // Caja / recaudo del día.
  cashSales: number;
  consignacionesVentas: number;
  abonosCash: number;
  abonosConsignacion: number;
  abonosTotal: number;
  /** Total recogido = contado neto + consignaciones + abonos. */
  totalCollected: number;
  // Venta del día (DEVENGADO).
  ordersTotal: number;
  newCreditsTotal: number;
  newCreditsCount: number;
  /** Venta del día = contado + consignación + crédito + pedidos. */
  salesRevenue: number;
  salesProfit: number;
  salesMargin: number;
  // Caja (cobrada) — base Meta del mes.
  profit: number;
  margin: number;
  /** Efectivo final de caja = recaudo − gastos variables. */
  finalTotal: number;
  // Gastos variables.
  expensesTotal: number;
  // Cartera pendiente (point-in-time).
  pendingCreditsCount: number;
  pendingCreditsBalance: number;
}

export interface BranchesDailyClosureResult {
  date: string;
  branches: BranchDailyClosure[];
  totals: BranchesClosureTotals;
}

interface OwnerCompanyRow {
  id: string;
  name: string;
  is_branch: boolean;
  is_active: boolean;
}

const round2 = (n: unknown): number => Number(toBig(n).round(2).toString());

@Injectable()
export class GetBranchesDailyClosureAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly dailyClosure: GetDailyClosureAction,
    private readonly resolvePermissions: ResolveEffectivePermissionsAction,
  ) {}

  async execute(actor: PermissionActor, dateInput?: string): Promise<BranchesDailyClosureResult> {
    const targetDate = dateInput ?? todayUtcDate();

    if (actor.company_id === null) {
      throw new ForbiddenException('Sesión sin empresa.');
    }
    const currentCompanyId = actor.company_id;

    // 0. Nivel ADMIN: owner/superadmin (todas las keys) o empleado con rol
    //    "Administrador" (todas las keys). Un Cajero NO pasa aunque tenga
    //    `canAccessDailyClosureReport`.
    const perms = await this.resolvePermissions.execute(actor);
    const permSet = new Set<PermissionKey>(perms);
    const isAdminLevel = PERMISSION_KEYS.every((k) => permSet.has(k));
    if (!isAdminLevel) {
      throw new ForbiddenException('Solo el administrador puede ver el resumen de sucursales.');
    }

    // 1. La company actual debe ser el negocio PRINCIPAL.
    const companyRows = await this.dataSource.query<{ is_branch: boolean }[]>(
      `SELECT is_branch FROM companies WHERE id = $1 LIMIT 1`,
      [String(currentCompanyId)],
    );
    if (companyRows.length === 0) {
      throw new ForbiddenException('Empresa no encontrada.');
    }
    if (companyRows[0].is_branch === true) {
      throw new ForbiddenException(
        'El resumen de sucursales solo está disponible desde el negocio principal.',
      );
    }

    // 2. Owner del negocio principal (uno por company: type='owner').
    const ownerRows = await this.dataSource.query<{ user_id: string }[]>(
      `SELECT id::text AS user_id FROM users WHERE company_id = $1 AND type = 'owner' LIMIT 1`,
      [String(currentCompanyId)],
    );
    if (ownerRows.length === 0) {
      throw new ForbiddenException('No se encontró el dueño del negocio.');
    }

    // 3. Companies del owner: principal (SIEMPRE) + sucursales ACTIVAS.
    const companies = await this.dataSource.query<OwnerCompanyRow[]>(
      `
      SELECT c.id::text AS id, c.name, c.is_branch, cm.is_active
      FROM company_members cm
      INNER JOIN companies c ON c.id = cm.company_id
      WHERE cm.user_id = $1
      ORDER BY c.is_branch ASC, c.id ASC
      `,
      [ownerRows[0].user_id],
    );
    const selected = companies.filter((c) => !c.is_branch || c.is_active);

    // 4. Cierre diario COMPLETO por company (misma maquinaria que el Resumen del
    //    día de cada una → paridad al centavo).
    const branches: BranchDailyClosure[] = await Promise.all(
      selected.map(async (c) => ({
        companyId: Number(c.id),
        name: c.name,
        isBranch: c.is_branch,
        closure: await this.dailyClosure.execute(Number(c.id), targetDate),
      })),
    );

    return {
      date: targetDate,
      branches,
      totals: this.buildTotals(branches.map((b) => b.closure)),
    };
  }

  /** Suma los titulares de cada cierre y recalcula los márgenes sobre el total. */
  private buildTotals(closures: DailyClosureResult[]): BranchesClosureTotals {
    const sum = (pick: (c: DailyClosureResult) => number): number =>
      round2(closures.reduce((acc, c) => acc.plus(toBig(pick(c))), toBig(0)).toNumber());

    const cashSales = sum((c) => c.cashSalesTotal);
    const consignacionesVentas = sum((c) => c.consignacionesVentas);
    const abonosCash = sum((c) => c.creditsBreakdown.abonosCash);
    const abonosConsignacion = sum((c) => c.creditsBreakdown.abonosConsignacion);
    const abonosTotal = sum((c) => c.creditsBreakdown.abonosTotal);
    const ordersTotal = sum((c) => c.ordersTotal);
    const newCreditsTotal = sum((c) => c.creditsBreakdown.newCreditsTotal);
    const newCreditsCount = closures.reduce(
      (acc, c) => acc + Number(c.creditsBreakdown.newCreditsCount),
      0,
    );
    const salesProfit = sum((c) => c.salesProfit);
    const profit = sum((c) => c.profit);
    const expensesTotal = sum((c) => c.expensesTotal);
    const finalTotal = sum((c) => c.finalTotal);
    const pendingCreditsCount = closures.reduce(
      (acc, c) => acc + Number(c.totalPendingCredits.count),
      0,
    );
    const pendingCreditsBalance = sum((c) => c.totalPendingCredits.balance);

    const totalCollected = round2(
      toBig(cashSales).plus(toBig(consignacionesVentas)).plus(toBig(abonosTotal)).toNumber(),
    );
    const salesRevenue = round2(
      toBig(cashSales)
        .plus(toBig(consignacionesVentas))
        .plus(toBig(newCreditsTotal))
        .plus(toBig(ordersTotal))
        .toNumber(),
    );
    const salesMargin =
      salesRevenue > 0 ? round2(toBig(salesProfit).div(salesRevenue).times(100).toNumber()) : 0;
    // Margen de caja sobre el recaudo (contado + consignación + abonos + pedidos),
    // mismo criterio que `GetDailyClosureAction` para `margin`.
    const cashRevenue = round2(
      toBig(cashSales)
        .plus(toBig(consignacionesVentas))
        .plus(toBig(abonosTotal))
        .plus(toBig(ordersTotal))
        .toNumber(),
    );
    const margin =
      cashRevenue > 0 ? round2(toBig(profit).div(cashRevenue).times(100).toNumber()) : 0;

    return {
      cashSales,
      consignacionesVentas,
      abonosCash,
      abonosConsignacion,
      abonosTotal,
      totalCollected,
      ordersTotal,
      newCreditsTotal,
      newCreditsCount,
      salesRevenue,
      salesProfit,
      salesMargin,
      profit,
      margin,
      finalTotal,
      expensesTotal,
      pendingCreditsCount,
      pendingCreditsBalance,
    };
  }
}
