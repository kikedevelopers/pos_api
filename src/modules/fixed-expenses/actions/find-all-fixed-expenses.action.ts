import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { FixedExpensePeriod } from '../entities/fixed-expense-period.entity';
import { FixedExpense } from '../entities/fixed-expense.entity';
import type { FixedExpensePendingStats } from '../dto/fixed-expense-response.dto';
import { fetchPendingStatsByCompany } from '../internal/fetch-pending-stats';

export interface FindAllFixedExpensesResult {
  expenses: FixedExpense[];
  pendingStats: Map<string, FixedExpensePendingStats>;
}

/**
 * Lista los gastos fijos ACTIVOS de la company, ordenados por `created_at DESC`.
 *
 * Espejo PlacePos `GET /fixed-expenses` con extensión multi-tenant. Filtra
 * `is_archived = false` (paridad). Para listados que incluyan archivados,
 * un endpoint dedicado puede agregarse en el futuro.
 *
 * Performance: el índice parcial `(company_id, name) WHERE is_archived=false`
 * cubre el filtro. El segundo query (pending stats) se hace en una sola
 * llamada agregada (GROUP BY) — no N+1.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class FindAllFixedExpensesAction {
  constructor(
    @InjectRepository(FixedExpense)
    private readonly expensesRepo: Repository<FixedExpense>,
    @InjectRepository(FixedExpensePeriod)
    private readonly periodsRepo: Repository<FixedExpensePeriod>,
  ) {}

  async execute(companyId: number): Promise<FindAllFixedExpensesResult> {
    const expenses = await this.expensesRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { created_at: 'DESC' },
    });

    const pendingStats = await fetchPendingStatsByCompany(this.periodsRepo, companyId);
    return { expenses, pendingStats };
  }
}
