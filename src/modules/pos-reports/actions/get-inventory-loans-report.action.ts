import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { parseUtcRange } from '@/modules/reports/internal/range';

import type { InventoryLoansQueryDto } from '../dto/inventory-loans-query.dto';
import {
  calcMargin,
  calcProfit,
  round2,
  salesDateFieldExpr,
  toIsoStr,
  zeroBig,
} from '../internal/sales-report-shared';

interface LoanRow {
  id: string;
  ticket_number: string;
  customer_name: string | null;
  created_by: string | null;
  total: number;
  cost: number;
  is_deleted: boolean;
  realized_at: Date;
}

export interface InventoryLoanTicket {
  id: number;
  ticketNumber: string;
  customerName: string;
  createdBy: string | null;
  total: number;
  cost: number;
  profit: number;
  margin: number;
  isDeleted: boolean;
  date: string;
}

export interface InventoryLoansReportResult {
  loans: InventoryLoanTicket[];
  summary: {
    // Nº de préstamos ACTIVOS (no anulados) en el rango.
    total_loans_count: number;
    // Nº de préstamos anulados incluidos (0 salvo showDeleted).
    total_voided_count: number;
    // Valor total prestado (Σ total de los préstamos activos).
    total_value: number;
    total_cost: number;
    total_profit: number;
    average_margin: number;
  };
}

/**
 * `GET /pos-reports/inventory-loans` — informe "Préstamo de Inventario".
 *
 * Lista los préstamos de mercancía a terceros (`ticket_type = 'LOAN'`) con los
 * mismos filtros del informe de ventas (rango de fechas, búsqueda) pero mucho
 * más simple: un préstamo no genera notas, créditos ni pagos, así que no hay
 * "tipo de pago" ni consolidación. El summary da la cantidad, el valor total,
 * la ganancia y el margen. Owner-only (el préstamo es una operación del dueño).
 *
 * Multi-tenancy: `si.company_id = $1` en TODA la query.
 */
@Injectable()
export class GetInventoryLoansReportAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    filters: InventoryLoansQueryDto,
  ): Promise<InventoryLoansReportResult> {
    if (!filters.dateFrom || !filters.dateTo) {
      throw new BadRequestException('dateFrom y dateTo son requeridos');
    }

    const range = parseUtcRange(filters.dateFrom, filters.dateTo);
    const cid = String(companyId);
    const dateExpr = salesDateFieldExpr(filters.dateField);

    const params: unknown[] = [cid, range.dateStart, range.dateEnd];
    const conditions: string[] = [
      'si.company_id = $1',
      // Un préstamo NUNCA es una venta: filtrar explícito por LOAN garantiza que
      // este informe SOLO muestre préstamos (y, en espejo, que un LOAN no aparezca
      // en el informe de ventas).
      "si.ticket_type = 'LOAN'",
      `${dateExpr} BETWEEN $2 AND $3`,
    ];

    if (!filters.showDeleted) {
      conditions.push('si.is_deleted = false');
    }

    if (filters.search?.trim()) {
      // Escapa los wildcards de ILIKE (`%`, `_`, `\`) para búsqueda literal.
      const escaped = filters.search.trim().replace(/[\\%_]/g, '\\$&');
      params.push(`%${escaped}%`);
      const ph = `$${params.length}`;
      conditions.push(
        `(si.customer_name ILIKE ${ph} ESCAPE '\\' OR si.ticket_number ILIKE ${ph} ESCAPE '\\')`,
      );
    }

    const sql = `
      SELECT
        si.id,
        si.ticket_number,
        si.customer_name,
        si.created_by,
        si.total,
        si.cost,
        si.is_deleted,
        ${dateExpr} AS realized_at
      FROM sale_invoices si
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${dateExpr} DESC
    `;

    const rows = await this.dataSource.query<LoanRow[]>(sql, params);

    const loans: InventoryLoanTicket[] = rows.map((r) => {
      const total = round2(r.total);
      const cost = round2(r.cost);
      return {
        id: Number(r.id),
        ticketNumber: r.ticket_number,
        customerName: r.customer_name ?? 'CONSUMIDOR FINAL',
        createdBy: r.created_by ?? null,
        total,
        cost,
        profit: calcProfit(total, cost),
        margin: calcMargin(total, cost),
        isDeleted: r.is_deleted,
        date: toIsoStr(r.realized_at),
      };
    });

    // El summary solo cuenta los préstamos ACTIVOS: un préstamo anulado devolvió
    // la mercancía al inventario, así que no representa mercancía prestada viva.
    const activeLoans = rows.filter((r) => !r.is_deleted);
    let totalValue = zeroBig();
    let totalCost = zeroBig();
    for (const r of activeLoans) {
      totalValue = totalValue.plus(toBig(r.total));
      totalCost = totalCost.plus(toBig(r.cost));
    }
    const totalValueNum = round2(totalValue.toNumber());
    const totalCostNum = round2(totalCost.toNumber());

    return {
      loans,
      summary: {
        total_loans_count: activeLoans.length,
        total_voided_count: rows.length - activeLoans.length,
        total_value: totalValueNum,
        total_cost: totalCostNum,
        total_profit: calcProfit(totalValueNum, totalCostNum),
        average_margin: calcMargin(totalValueNum, totalCostNum),
      },
    };
  }
}
