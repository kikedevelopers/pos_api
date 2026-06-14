import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber } from '@/common/utils/precision';
import { AppAlert, AlertSeverity } from '@/modules/app-alerts/entities/app-alert.entity';
import { RealtimeGateway } from '@/modules/realtime/realtime.gateway';

import { FixedExpensePeriod } from '../entities/fixed-expense-period.entity';
import { FixedExpense } from '../entities/fixed-expense.entity';
import {
  amountForPeriod,
  dueAtForPeriod,
  expectedCompletedPeriods,
  type ScheduleExpense,
} from '../internal/period-schedule';

/** Tipo de alerta de corte vencido (paridad PlacePos `FIXED_EXPENSE_DUE`). */
export const FIXED_EXPENSE_DUE_ALERT_TYPE = 'FIXED_EXPENSE_DUE';

/**
 * Cooldown del trigger LAZY por company. El badge/listado consulta seguido; sin
 * esta protección el sync correría decenas de veces por minuto sin razón. El
 * `force: true` (create/update) lo ignora para garantizar la corrida inmediata.
 */
const SYNC_COOLDOWN_MS = 60_000;

export interface SyncDuePeriodsOptions {
  /** Salta el cooldown (usar tras crear/editar start_date o period_*). */
  force?: boolean;
}

export interface SyncDuePeriodsResult {
  processedExpenses: number;
  createdPeriods: number;
  skipped: boolean;
}

interface InsertedPeriodRow {
  id: string;
}

const currencyFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * `SyncDuePeriodsAction` — materializa los cortes vencidos de una company.
 *
 * Espejo cloud (multi-tenant) de `placepos/src/main/services/fixedExpensePeriods/
 * syncDuePeriods.ts`, extendido con el algoritmo de calendario §2 del contrato.
 *
 * Propiedades:
 *   - Multi-tenant: SIEMPRE filtra por `company_id`.
 *   - Idempotente: `INSERT ... ON CONFLICT DO NOTHING` sobre
 *     `UNIQUE (fixed_expense_id, period_number)`. Si dos requests corren a la
 *     vez, solo uno persiste el corte (y su alerta).
 *   - `due_at(n)` / `amount(n)` vía `period-schedule` (calendario §2 + legacy
 *     por horas fijas). `amount` completo SIEMPRE.
 *   - Genera la alerta `FIXED_EXPENSE_DUE` por cada corte recién creado y enlaza
 *     `alert_id` al periodo. NO hay dedup por firma en `app_alerts`: la única
 *     garantía de no duplicar alertas es el UNIQUE del corte — la alerta solo se
 *     crea cuando el INSERT del periodo fue efectivo (`raw` no vacío). Como
 *     ninguna otra vía crea periodos (mark-paid solo marca), basta con eso.
 *   - Cooldown por company (mapa en memoria) para el trigger lazy; `force`
 *     desde create/update.
 *   - Cada corte se inserta en su propia transacción: el INSERT con ON CONFLICT
 *     actúa como lock implícito y evita alertas huérfanas si otro proceso ganó
 *     la carrera. Un gasto fallido no bloquea el resto del lote.
 *
 * §8.8: toda mutación va en `dataSource.transaction`. Big.js (`preciseNumber`)
 * para normalizar montos antes de persistir.
 */
@Injectable()
export class SyncDuePeriodsAction {
  private readonly logger = new Logger(SyncDuePeriodsAction.name);

  /** Última corrida lazy por company (epoch ms). Clave = companyId. */
  private readonly lastSyncByCompany = new Map<number, number>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly realtime: RealtimeGateway,
  ) {}

  async execute(
    companyId: number,
    now: Date = new Date(),
    options: SyncDuePeriodsOptions = {},
  ): Promise<SyncDuePeriodsResult> {
    if (!options.force && this.isWithinCooldown(companyId)) {
      return { processedExpenses: 0, createdPeriods: 0, skipped: true };
    }
    this.lastSyncByCompany.set(companyId, Date.now());

    const expenses = await this.dataSource.getRepository(FixedExpense).find({
      where: { company_id: String(companyId), is_archived: false },
    });

    let createdPeriods = 0;
    for (const expense of expenses) {
      try {
        createdPeriods += await this.syncForExpense(companyId, expense, now);
      } catch (err) {
        // Un gasto fallido no debe abortar el resto del lote.
        this.logger.error(
          `Fallo sincronizando cortes del gasto ${expense.id} (${expense.name}) ` +
            `de la company ${companyId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Si se materializó al menos un corte, cada uno generó su alerta
    // FIXED_EXPENSE_DUE. Empuja una sola señal a la campana del admin (el cliente
    // refetchea la lista completa). Best-effort: un fallo de socket no afecta el
    // resultado del sync.
    if (createdPeriods > 0) {
      try {
        this.realtime.emitAlertCreated(companyId, {
          companyId,
          alertType: FIXED_EXPENSE_DUE_ALERT_TYPE,
          severity: AlertSeverity.WARNING,
        });
      } catch (err) {
        this.logger.warn(
          `No se pudo emitir alert:created (FIXED_EXPENSE_DUE) para company ${companyId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { processedExpenses: expenses.length, createdPeriods, skipped: false };
  }

  private isWithinCooldown(companyId: number): boolean {
    const last = this.lastSyncByCompany.get(companyId);
    return last !== undefined && Date.now() - last < SYNC_COOLDOWN_MS;
  }

  /**
   * Sincroniza los cortes vencidos de UN gasto. Lee los `period_number` ya
   * existentes una sola vez (evita N+1) y crea los faltantes 1..expected.
   */
  private async syncForExpense(
    companyId: number,
    expense: FixedExpense,
    now: Date,
  ): Promise<number> {
    const schedule: ScheduleExpense = {
      period_unit: expense.period_unit,
      period_quantity: expense.period_quantity,
      start_date: expense.start_date,
      amount: expense.amount,
    };

    const expected = expectedCompletedPeriods(schedule, now);
    if (expected <= 0) {
      return 0;
    }

    const existingRows = await this.dataSource.getRepository(FixedExpensePeriod).find({
      where: { fixed_expense_id: expense.id, company_id: String(companyId) },
      select: { period_number: true },
    });
    const existingNumbers = new Set(existingRows.map((r) => r.period_number));

    let created = 0;
    for (let n = 1; n <= expected; n++) {
      if (existingNumbers.has(n)) {
        continue;
      }
      const ok = await this.dataSource.transaction((manager) =>
        this.persistMissingPeriod(manager, companyId, expense, schedule, n),
      );
      if (ok) {
        created += 1;
      }
    }
    return created;
  }

  /**
   * Inserta el corte `n` y su alerta dentro de UNA transacción. El INSERT con
   * `orIgnore()` (ON CONFLICT DO NOTHING) determina si esta corrida fue la que
   * persistió el corte: si `raw` viene vacío hubo conflicto y NO se crea alerta.
   */
  private async persistMissingPeriod(
    manager: EntityManager,
    companyId: number,
    expense: FixedExpense,
    schedule: ScheduleExpense,
    n: number,
  ): Promise<boolean> {
    const dueAt = dueAtForPeriod(schedule, n);
    const amount = preciseNumber(amountForPeriod(schedule), 2);

    const insertResult = await manager
      .createQueryBuilder()
      .insert()
      .into(FixedExpensePeriod)
      .values({
        company_id: String(companyId),
        fixed_expense_id: expense.id,
        period_number: n,
        due_at: dueAt,
        amount,
        // Corte recién creado: nada pagado, saldo = monto total (§1).
        paid_amount: 0,
        balance: amount,
        status: 'PENDING',
        alert_id: null,
      })
      .orIgnore()
      .returning(['id'])
      .execute();

    const insertedRows = (insertResult.raw as InsertedPeriodRow[]) ?? [];
    if (insertedRows.length === 0) {
      // ON CONFLICT DO NOTHING: otro proceso ya creó este corte. No tocamos nada.
      return false;
    }

    const periodId = insertedRows[0].id;

    const alert = await manager.getRepository(AppAlert).save(
      manager.create(AppAlert, {
        company_id: String(companyId),
        type: FIXED_EXPENSE_DUE_ALERT_TYPE,
        severity: AlertSeverity.WARNING,
        title: `Gasto fijo vencido: ${expense.name}`,
        message:
          `Se cumplió un periodo de "${expense.name}". ` +
          `Pago a realizar: ${currencyFormatter.format(amount)}.`,
        is_read: false,
        metadata: {
          fixed_expense_id: Number(expense.id),
          fixed_expense_name: expense.name,
          period_number: n,
          amount,
          due_at: dueAt.toISOString(),
        },
      }),
    );

    await manager.update(FixedExpensePeriod, periodId, { alert_id: alert.id });
    return true;
  }
}
