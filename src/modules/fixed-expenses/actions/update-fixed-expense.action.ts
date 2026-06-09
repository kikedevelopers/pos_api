import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateFixedExpenseDto } from '../dto/update-fixed-expense.dto';
import { FixedExpense } from '../entities/fixed-expense.entity';
import { isCalendarPeriodUnit } from '../internal/period-schedule';
import { SyncDuePeriodsAction } from './sync-due-periods.action';

/**
 * Actualiza metadata/parámetros de un FixedExpense activo.
 *
 * Reglas:
 *   - Solo gastos NO archivados se pueden editar (paridad PlacePos: filtro
 *     `is_archived: false` en el lookup).
 *   - Update parcial — solo se aplica lo presente en el DTO.
 *   - Normalización: si el `period_unit` resultante es de calendario,
 *     `period_quantity` se fuerza a `1` (§1/§2 del contrato).
 *   - Cambiar `period_unit`, `period_quantity` o `start_date` puede destapar
 *     nuevos cortes vencidos → se dispara `SyncDuePeriodsAction` con
 *     `force: true` DESPUÉS del commit (paridad PlacePos). Cambios solo de
 *     metadata (name/description/amount) NO disparan sync.
 *
 * §8.8: toda mutación en transacción; el sync corre fuera (sus propias tx).
 */
@Injectable()
export class UpdateFixedExpenseAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly syncDuePeriodsAction: SyncDuePeriodsAction,
  ) {}

  async execute(id: number, companyId: number, dto: UpdateFixedExpenseDto): Promise<FixedExpense> {
    const { updated, scheduleChanged } = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(FixedExpense, {
        where: { id: String(id), company_id: String(companyId), is_archived: false },
      });
      if (!existing) {
        throw new NotFoundException('Gasto fijo no encontrado.');
      }

      const updatePayload: Partial<FixedExpense> = {};
      // Cambios que afectan el calendario de cortes → requieren re-sync forzado.
      let changedSchedule = false;

      if (dto.name !== undefined) {
        updatePayload.name = dto.name.trim();
      }
      if (dto.description !== undefined) {
        updatePayload.description = dto.description?.trim() || null;
      }
      if (dto.amount !== undefined) {
        updatePayload.amount = dto.amount;
      }
      if (dto.period_unit !== undefined) {
        updatePayload.period_unit = dto.period_unit;
        changedSchedule = true;
      }
      if (dto.period_quantity !== undefined) {
        updatePayload.period_quantity = dto.period_quantity;
        changedSchedule = true;
      }
      if (dto.start_date !== undefined) {
        updatePayload.start_date = new Date(dto.start_date);
        changedSchedule = true;
      }

      // Normaliza period_quantity a 1 cuando el unit final es de calendario.
      const finalUnit = updatePayload.period_unit ?? existing.period_unit;
      if (isCalendarPeriodUnit(finalUnit)) {
        updatePayload.period_quantity = 1;
      }

      if (Object.keys(updatePayload).length > 0) {
        await manager.update(
          FixedExpense,
          { id: String(id), company_id: String(companyId) },
          updatePayload,
        );
      }

      const fresh = await manager.findOneOrFail(FixedExpense, {
        where: { id: String(id), company_id: String(companyId) },
      });
      return { updated: fresh, scheduleChanged: changedSchedule };
    });

    // Force sync solo si cambió el calendario (start_date/period_*).
    if (scheduleChanged) {
      await this.syncDuePeriodsAction.execute(companyId, new Date(), { force: true });
    }

    return updated;
  }
}
