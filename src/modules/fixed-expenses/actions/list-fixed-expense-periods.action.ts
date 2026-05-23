import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { FixedExpensePeriod } from '../entities/fixed-expense-period.entity';
import { FixedExpense } from '../entities/fixed-expense.entity';

/**
 * Lista los cortes (periods) de un FixedExpense específico de la company,
 * ordenados por `period_number ASC`.
 *
 * Anti-IDOR: primero valida que el FixedExpense parent pertenezca al tenant.
 * Si no, devolver 404 (sin filtrar existencia cross-tenant).
 *
 * Performance: el índice `(fixed_expense_id, status)` cubre el filtro del
 * sub-query típico (cortes pendientes); aquí pedimos todos y el orden por
 * `period_number` aprovecha que la mayoría de FixedExpenses tienen pocos
 * cortes en horizonte razonable.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class ListFixedExpensePeriodsAction {
  constructor(
    @InjectRepository(FixedExpense)
    private readonly expensesRepo: Repository<FixedExpense>,
    @InjectRepository(FixedExpensePeriod)
    private readonly periodsRepo: Repository<FixedExpensePeriod>,
  ) {}

  async execute(fixedExpenseId: number, companyId: number): Promise<FixedExpensePeriod[]> {
    const parent = await this.expensesRepo.findOne({
      where: { id: String(fixedExpenseId), company_id: String(companyId) },
      select: { id: true },
    });
    if (!parent) {
      throw new NotFoundException('Gasto fijo no encontrado.');
    }

    return this.periodsRepo.find({
      where: {
        company_id: String(companyId),
        fixed_expense_id: String(fixedExpenseId),
      },
      order: { period_number: 'ASC' },
    });
  }
}
