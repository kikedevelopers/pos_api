import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';

export interface SalesMonth {
  /** 'YYYY-MM' en hora Colombia. */
  month: string;
  salesCount: number;
}

export interface SalesMonthsResult {
  months: SalesMonth[];
}

/**
 * Meses que tienen ventas, para poblar el selector del extracto mensual.
 * Espejo PlacePos (`GET /pos-reports/sales/months`).
 *
 * Se agrupa por la fecha de VENTA en hora Colombia (America/Bogota): agrupar en
 * UTC mandaría a otro mes las ventas hechas después de las 7 p.m. del último
 * día, y el extracto de ese mes saldría sin ellas.
 *
 * Devuelve solo los meses CON ventas; el hueco intermedio (un mes cerrado, sin
 * una sola venta) lo rellena el front, que es quien conoce el rango a mostrar.
 */
@Injectable()
export class GetSalesMonthsAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly resolvePermissions: ResolveEffectivePermissionsAction,
    private readonly getIncludeOrdersInReports: GetIncludeOrdersInReportsAction,
  ) {}

  async execute(companyId: number, actor: AuthUser): Promise<SalesMonthsResult> {
    const cid = String(companyId);
    const effective = await this.resolvePermissions.execute({
      type: actor.type,
      account: actor.account,
      user_id: actor.user_id,
      company_id: actor.company_id,
    });
    const scopeToUserId = effective.includes('canViewAllSales') ? null : String(actor.user_id);
    const { enabled: includeOrders } = await this.getIncludeOrdersInReports.execute(companyId);

    const params: unknown[] = [cid];
    const conditions = [`si.company_id = $1`, `si.is_deleted = false`];

    // Mismo criterio de tipos que el extracto: las ventas siempre; los pedidos
    // solo cuando el flag los suma a los ingresos. Si no, el selector ofrecería
    // meses cuyo extracto sale vacío.
    conditions.push(
      includeOrders ? `si.ticket_type::text IN ('SALE','ORDER')` : `si.ticket_type::text = 'SALE'`,
    );

    if (scopeToUserId !== null) {
      params.push(scopeToUserId);
      conditions.push(`si.created_by_id = $${params.length}`);
    }

    const rows = await this.dataSource.query<{ month: string; sales_count: string }[]>(
      `
      SELECT
        to_char(
          COALESCE(si.sold_at, si.created_at) AT TIME ZONE 'America/Bogota',
          'YYYY-MM'
        ) AS month,
        COUNT(*) AS sales_count
      FROM sale_invoices si
      WHERE ${conditions.join(' AND ')}
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      params,
    );

    return {
      months: rows.map((r) => ({ month: r.month, salesCount: Number(r.sales_count) })),
    };
  }
}
