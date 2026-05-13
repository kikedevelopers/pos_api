import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import type { CreditsReportQueryDto } from '../dto/credits-report-query.dto';
import { parseUtcRange } from '../internal/range';

interface CreditReportRow {
  id: string;
  ticket_number: string;
  sale_number: string | null;
  customer_name: string | null;
  created_by: string | null;
  created_at: Date;
  credit_id: string | null;
  total_amount: number;
  paid_amount: number;
  balance: number;
  status: string;
  due_date: Date | string | null;
}

export interface CreditReportItem {
  id: number;
  creditId: number | null;
  ticketNumber: string;
  saleNumber: string | null;
  customerName: string;
  createdBy: string | null;
  synced: true;
  createdAt: string;
  totalAmount: number;
  paidAmount: number;
  balance: number;
  status: string;
  dueDate: string | null;
}

export interface CreditsReportResult {
  credits: CreditReportItem[];
  summary: {
    total_credits_count: number;
    pending_count: number;
    partial_count: number;
    paid_count: number;
    total_amount: number;
    total_paid: number;
    total_balance: number;
  };
}

/**
 * `GET /reports/credits?dateFrom=&dateTo=&search=&status=`.
 *
 * Espejo PlacePos. Listado con filtros opcionales + summary agregado.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * `sc.company_id = $1` Y `si.company_id = $1` en el JOIN. Si una se omitiera,
 * leeríamos créditos de otra company. El parámetro $1 es siempre el
 * companyId.
 *
 * --------------------------------------------------------------------------
 * Performance
 * --------------------------------------------------------------------------
 *
 * Sin paginación (PlacePos tampoco la usa). El listado de créditos pendientes
 * raramente excede unos cientos por company; si crece, considerar LIMIT/OFFSET
 * en una versión v2 del endpoint.
 *
 * Índices usados:
 *   - `idx_sale_credits_company_id` (filtro de tenant).
 *   - `idx_sale_invoices_company_active_created` (JOIN + filtro fecha).
 */
@Injectable()
export class GetCreditsReportAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, filters: CreditsReportQueryDto): Promise<CreditsReportResult> {
    const conditions: string[] = [
      `sc.company_id = $1`,
      `si.company_id = $1`,
      `si.ticket_type = 'SALE'`,
      `si.is_deleted = false`,
    ];
    const params: unknown[] = [String(companyId)];
    const placeholder = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // MED-1 auditoría Fase 11: validar el rango (`to >= from` + MAX_RANGE_DAYS)
    // antes de tocar la query. Si solo llega uno de los dos, se ignora (paridad
    // PlacePos). parseUtcRange ya escapa el formato (BadRequestException 400).
    if (filters.dateFrom && filters.dateTo) {
      const range = parseUtcRange(filters.dateFrom, filters.dateTo);
      conditions.push(`si.created_at >= ${placeholder(range.dateStart)}`);
      conditions.push(`si.created_at <= ${placeholder(range.dateEnd)}`);
    }

    if (filters.search?.trim()) {
      // MED-2 auditoría Fase 11: escapar wildcards de ILIKE. Sin el escape,
      // un cliente con `search=%_a` interpretaría `%` y `_` como wildcards
      // y devolvería resultados engañosos. Mantenemos paridad funcional
      // (substring match) pero solo sobre el texto literal.
      const escaped = filters.search.trim().replace(/[\\%_]/g, '\\$&');
      const ph = placeholder(`%${escaped}%`);
      conditions.push(
        `(si.customer_name ILIKE ${ph} ESCAPE '\\' OR si.ticket_number ILIKE ${ph} ESCAPE '\\' OR si.sale_number ILIKE ${ph} ESCAPE '\\')`,
      );
    }

    if (filters.status && filters.status !== 'ALL') {
      const ph = placeholder(filters.status);
      conditions.push(`sc.status::text = ${ph}`);
    }

    const sql = `
      SELECT
        si.id::text AS id,
        si.ticket_number,
        si.sale_number,
        si.customer_name,
        si.created_by,
        si.created_at,
        sc.id::text AS credit_id,
        sc.total_amount::float AS total_amount,
        sc.paid_amount::float AS paid_amount,
        sc.balance::float AS balance,
        sc.status::text AS status,
        sc.due_date
      FROM sale_credits sc
      INNER JOIN sale_invoices si
        ON si.id = sc.sale_invoice_id
       AND si.company_id = $1
      WHERE ${conditions.join(' AND ')}
      ORDER BY si.created_at DESC
    `;

    const rows = await this.dataSource.query<CreditReportRow[]>(sql, params);

    let totalAmount = new Big(0);
    let totalPaid = new Big(0);
    let totalBalance = new Big(0);

    const credits: CreditReportItem[] = rows.map((row) => {
      totalAmount = totalAmount.plus(row.total_amount);
      totalPaid = totalPaid.plus(row.paid_amount);
      totalBalance = totalBalance.plus(row.balance);

      const dueDate = ((): string | null => {
        if (!row.due_date) {
          return null;
        }
        if (row.due_date instanceof Date) {
          return row.due_date.toISOString().slice(0, 10);
        }
        const s = String(row.due_date);
        // Soporta ya formato 'YYYY-MM-DD' o ISO.
        return s.slice(0, 10);
      })();

      return {
        id: Number(row.id),
        creditId: row.credit_id ? Number(row.credit_id) : null,
        ticketNumber: row.ticket_number,
        saleNumber: row.sale_number,
        customerName: row.customer_name ?? 'CONSUMIDOR FINAL',
        createdBy: row.created_by ?? null,
        synced: true,
        createdAt:
          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        totalAmount: Number(new Big(row.total_amount).round(2).toString()),
        paidAmount: Number(new Big(row.paid_amount).round(2).toString()),
        balance: Number(new Big(row.balance).round(2).toString()),
        status: row.status,
        dueDate,
      };
    });

    const summary = {
      total_credits_count: rows.length,
      pending_count: rows.filter((r) => r.status === 'PENDING').length,
      partial_count: rows.filter((r) => r.status === 'PARTIALLY_PAID').length,
      paid_count: rows.filter((r) => r.status === 'PAID').length,
      total_amount: Number(totalAmount.round(2).toString()),
      total_paid: Number(totalPaid.round(2).toString()),
      total_balance: Number(totalBalance.round(2).toString()),
    };

    return { credits, summary };
  }
}
