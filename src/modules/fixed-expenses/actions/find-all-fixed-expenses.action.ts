import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { FixedExpensePeriod } from '../entities/fixed-expense-period.entity';
import { FixedExpense } from '../entities/fixed-expense.entity';
import type { FixedExpensePendingStats } from '../dto/fixed-expense-response.dto';
import { fetchPendingStatsByCompany } from '../internal/fetch-pending-stats';
import { SyncDuePeriodsAction } from './sync-due-periods.action';

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
 * Side effect: dispara el sync LAZY de cortes vencidos de la company ANTES de
 * leer pending stats (respetando el cooldown por company). Así el listado
 * refleja los cortes recién vencidos sin depender de un cron. El sync nunca
 * rompe el read: si falla, se loguea y se continúa con lo persistido.
 *
 * El read en sí es puro — sin transacción (el sync gestiona la suya).
 */
@Injectable()
export class FindAllFixedExpensesAction {
  private readonly logger = new Logger(FindAllFixedExpensesAction.name);

  constructor(
    @InjectRepository(FixedExpense)
    private readonly expensesRepo: Repository<FixedExpense>,
    @InjectRepository(FixedExpensePeriod)
    private readonly periodsRepo: Repository<FixedExpensePeriod>,
    private readonly syncDuePeriodsAction: SyncDuePeriodsAction,
  ) {}

  async execute(companyId: number): Promise<FindAllFixedExpensesResult> {
    // Lazy sync (con cooldown) ANTES de leer las stats, para que cortes recién
    // vencidos cuenten. Aislado: una falla del sync no rompe el listado.
    try {
      await this.syncDuePeriodsAction.execute(companyId);
    } catch (err) {
      this.logger.error(
        `Sync lazy de cortes falló para company ${companyId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const expenses = await this.expensesRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { created_at: 'DESC' },
    });

    const pendingStats = await fetchPendingStatsByCompany(this.periodsRepo, companyId);
    return { expenses, pendingStats };
  }
}
