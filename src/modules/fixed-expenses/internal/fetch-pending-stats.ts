import type { Repository } from 'typeorm';

import type { FixedExpensePeriod } from '../entities/fixed-expense-period.entity';
import type { FixedExpensePendingStats } from '../dto/fixed-expense-response.dto';

interface PendingStatsRow {
  fixed_expense_id: string;
  pending_count: string;
  pending_total: string;
}

/**
 * Calcula `(count, total)` de cortes con status='PENDING' agrupados por
 * `fixed_expense_id`, restringido al tenant.
 *
 * Una sola query con `GROUP BY` para evitar N+1 — el listado de
 * `fixed_expenses` enriquece cada fila con sus stats sin disparar una query
 * por gasto.
 *
 * Paridad PlacePos `fixed-expenses.routes.ts::fetchPendingStats`, extendida
 * con filtro multi-tenant.
 */
export async function fetchPendingStatsByCompany(
  repo: Repository<FixedExpensePeriod>,
  companyId: number,
): Promise<Map<string, FixedExpensePendingStats>> {
  const rows = await repo
    .createQueryBuilder('p')
    .select('p.fixed_expense_id', 'fixed_expense_id')
    .addSelect('COUNT(p.id)', 'pending_count')
    .addSelect('COALESCE(SUM(p.amount), 0)', 'pending_total')
    .where('p.company_id = :companyId', { companyId: String(companyId) })
    .andWhere('p.status = :status', { status: 'PENDING' })
    .groupBy('p.fixed_expense_id')
    .getRawMany<PendingStatsRow>();

  const result = new Map<string, FixedExpensePendingStats>();
  for (const row of rows) {
    result.set(row.fixed_expense_id, {
      count: Number(row.pending_count),
      total: Number(row.pending_total),
    });
  }
  return result;
}
