import { In, type Repository } from 'typeorm';

import { Expense } from '@/modules/expenses/entities/expense.entity';

import {
  FixedExpensePaymentDto,
  toFixedExpensePaymentDto,
} from '../dto/fixed-expense-period-response.dto';

/**
 * Carga, en UNA sola consulta, todos los abonos (`expenses` con `is_fixed = true`)
 * de los cortes indicados y los agrupa por `fixed_expense_period_id`. Es la base
 * del histórico que se embebe en cada corte serializado.
 *
 * Se incluyen los archivados (anulados) para no romper la trazabilidad; el
 * cliente los marca como tales. Multi-tenant: filtra por `company_id`.
 *
 * Acepta cualquier `Repository<Expense>` — el de DI (lecturas) o el del manager
 * de una transacción (snapshot tras un pago).
 */
export async function loadPeriodPayments(
  expensesRepo: Repository<Expense>,
  companyId: number,
  periodIds: string[],
): Promise<Map<string, FixedExpensePaymentDto[]>> {
  const byPeriod = new Map<string, FixedExpensePaymentDto[]>();
  if (periodIds.length === 0) {
    return byPeriod;
  }

  const rows = await expensesRepo.find({
    where: {
      company_id: String(companyId),
      fixed_expense_period_id: In(periodIds),
      is_fixed: true,
    },
    // id ASC desempata abonos con el mismo created_at (pago multi-corte en una
    // misma transacción comparte el instante de `now()`).
    order: { created_at: 'ASC', id: 'ASC' },
  });

  for (const expense of rows) {
    const key = String(expense.fixed_expense_period_id);
    const list = byPeriod.get(key) ?? [];
    list.push(toFixedExpensePaymentDto(expense));
    byPeriod.set(key, list);
  }

  return byPeriod;
}
