import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber } from '@/common/utils/precision';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

/**
 * Shape de respuesta de `GET /suppliers/analytics`. Espejo PlacePos:
 *
 *   {
 *     suppliers_count,         // total no-archivados
 *     new_suppliers,           // creados en el mes actual
 *     evolution: { month_current, month_previous },
 *     total_debt,              // SUM(accumulated_debt) no-archivados
 *     total_credit_balance,    // SUM(credit_balance) no-archivados
 *   }
 */
export interface SuppliersAnalyticsResponse {
  suppliers_count: number;
  new_suppliers: number;
  evolution: {
    month_current: number;
    month_previous: number;
  };
  total_debt: number;
  total_credit_balance: number;
}

/**
 * Calcula analíticas agregadas del módulo suppliers (espejo PlacePos).
 *
 * Multi-tenancy: TODOS los SUM/COUNT filtran por `company_id`. Sin él
 * habría fuga cross-tenant trivial (lectura de saldos de otros tenants).
 *
 * Para los conteos por mes usa `date_trunc('month', ... AT TIME ZONE 'UTC')`
 * comparando contra `now() AT TIME ZONE 'UTC'` y `now() - interval '1 month'`.
 * Robusto a meses bisiestos.
 *
 * Read puro fuera de transacción. 1 query (combina todos los agregados con
 * subqueries) para minimizar round-trips.
 */
@Injectable()
export class GetSuppliersAnalyticsAction {
  constructor(
    @InjectRepository(Supplier)
    private readonly repo: Repository<Supplier>,
  ) {}

  async execute(companyId: number): Promise<SuppliersAnalyticsResponse> {
    const cidParam = String(companyId);

    const rows: Array<{
      total: string;
      month_current: string;
      month_previous: string;
      total_debt: string | null;
      total_credit_balance: string | null;
    }> = await this.repo.query(
      `
      SELECT
        COUNT(*)::bigint                                                  AS total,
        SUM(
          CASE
            WHEN date_trunc('month', created_at AT TIME ZONE 'UTC')
                 = date_trunc('month', now() AT TIME ZONE 'UTC')
            THEN 1 ELSE 0
          END
        )::bigint                                                         AS month_current,
        SUM(
          CASE
            WHEN date_trunc('month', created_at AT TIME ZONE 'UTC')
                 = date_trunc('month', (now() AT TIME ZONE 'UTC') - interval '1 month')
            THEN 1 ELSE 0
          END
        )::bigint                                                         AS month_previous,
        SUM(accumulated_debt)::numeric                                    AS total_debt,
        SUM(credit_balance)::numeric                                      AS total_credit_balance
      FROM suppliers
      WHERE company_id = $1
        AND is_archived = false
      `,
      [cidParam],
    );

    const row = rows[0];
    const suppliers_count = Number(row?.total ?? 0);
    const month_current = Number(row?.month_current ?? 0);
    const month_previous = Number(row?.month_previous ?? 0);
    const total_debt = preciseNumber(row?.total_debt ?? 0, 2);
    const total_credit_balance = preciseNumber(row?.total_credit_balance ?? 0, 2);

    return {
      suppliers_count,
      new_suppliers: month_current,
      evolution: {
        month_current,
        month_previous,
      },
      total_debt,
      total_credit_balance,
    };
  }
}
