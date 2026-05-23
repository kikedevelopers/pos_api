import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateFixedExpenseDto } from '../dto/create-fixed-expense.dto';
import { FixedExpense } from '../entities/fixed-expense.entity';

export interface FixedExpenseActor {
  id: number;
  fullName: string;
}

/**
 * Inserta un FixedExpense de la company.
 *
 * §8.8: TODA mutación en `dataSource.transaction`. Aquí solo hay un INSERT,
 * pero futuras adiciones (registro de auditoría, generación inmediata del
 * primer corte si `start_date <= now()`) quedarán en la misma tx.
 *
 * NOTA: PlacePos dispara un `syncDuePeriods({ force: true })` después del
 * POST para que cortes con `start_date` en el pasado aparezcan en la
 * respuesta inmediata. En este API CLOUD ese scheduler aún no existe; el
 * sync lazy se queda como TODO de la siguiente Ola — los periodos se
 * crearán por demanda o por un cron job dedicado cuando esté disponible.
 */
@Injectable()
export class CreateFixedExpenseAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreateFixedExpenseDto,
    companyId: number,
    actor: FixedExpenseActor,
  ): Promise<FixedExpense> {
    return this.dataSource.transaction<FixedExpense>(async (manager) => {
      const entity = manager.create(FixedExpense, {
        company_id: String(companyId),
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        amount: dto.amount,
        period_unit: dto.period_unit,
        period_quantity: dto.period_quantity,
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
  }
}
