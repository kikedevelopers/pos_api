import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateFixedExpenseDto } from '../dto/create-fixed-expense.dto';
import { FixedExpense } from '../entities/fixed-expense.entity';
import { isCalendarPeriodUnit } from '../internal/period-schedule';
import { SyncDuePeriodsAction } from './sync-due-periods.action';

export interface FixedExpenseActor {
  id: number;
  fullName: string;
}

/**
 * Inserta un FixedExpense de la company.
 *
 * §8.8: TODA mutación en `dataSource.transaction`. El INSERT vive en la tx; el
 * sync forzado de cortes corre DESPUÉS del commit (sus propias transacciones)
 * para que el nuevo gasto sea visible.
 *
 * Normalización: para convenciones de calendario (`semimonthly`/`end_of_month`)
 * `period_quantity` se ignora y se persiste `1` (§1/§2 del contrato).
 *
 * Side effect: tras crear, dispara `SyncDuePeriodsAction` con `force: true`
 * (espejo de PlacePos `syncDuePeriods({ force: true })`) para que cortes con
 * `start_date` en el pasado aparezcan de inmediato. La falla del sync no
 * revierte la creación.
 */
@Injectable()
export class CreateFixedExpenseAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly syncDuePeriodsAction: SyncDuePeriodsAction,
  ) {}

  async execute(
    dto: CreateFixedExpenseDto,
    companyId: number,
    actor: FixedExpenseActor,
  ): Promise<FixedExpense> {
    const created = await this.dataSource.transaction<FixedExpense>(async (manager) => {
      // Calendario: period_quantity se normaliza a 1 (se ignora lo recibido).
      const periodQuantity = isCalendarPeriodUnit(dto.period_unit)
        ? 1
        : (dto.period_quantity as number);

      const entity = manager.create(FixedExpense, {
        company_id: String(companyId),
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        amount: dto.amount,
        period_unit: dto.period_unit,
        period_quantity: periodQuantity,
        start_date: new Date(dto.start_date),
        is_archived: false,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });

      const saved = await manager.save(FixedExpense, entity);
      // Re-fetch para garantizar transformers numéricos y defaults aplicados.
      const fresh = await manager.findOneOrFail(FixedExpense, {
        where: { id: saved.id, company_id: String(companyId) },
      });
      return fresh;
    });

    // Force sync tras el commit: el gasto recién creado ya es visible.
    await this.syncDuePeriodsAction.execute(companyId, new Date(), { force: true });

    return created;
  }
}
