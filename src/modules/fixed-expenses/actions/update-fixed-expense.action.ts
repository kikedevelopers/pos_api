import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateFixedExpenseDto } from '../dto/update-fixed-expense.dto';
import { FixedExpense } from '../entities/fixed-expense.entity';

/**
 * Actualiza metadata/parámetros de un FixedExpense activo.
 *
 * Reglas:
 *   - Solo gastos NO archivados se pueden editar (paridad PlacePos: filtro
 *     `is_archived: false` en el lookup).
 *   - Update parcial — solo se aplica lo presente en el DTO.
 *   - Cambiar `period_unit`, `period_quantity` o `start_date` puede destapar
 *     nuevos cortes vencidos: el sync forzado de PlacePos queda como TODO en
 *     el cloud hasta que el scheduler esté disponible.
 *
 * §8.8: toda mutación en transacción.
 */
@Injectable()
export class UpdateFixedExpenseAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, dto: UpdateFixedExpenseDto): Promise<FixedExpense> {
    return this.dataSource.transaction<FixedExpense>(async (manager) => {
      const existing = await manager.findOne(FixedExpense, {
        where: { id: String(id), company_id: String(companyId), is_archived: false },
      });
      if (!existing) {
        throw new NotFoundException('Gasto fijo no encontrado.');
      }

      const updatePayload: Partial<FixedExpense> = {};

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
      }
      if (dto.period_quantity !== undefined) {
        updatePayload.period_quantity = dto.period_quantity;
      }
      if (dto.start_date !== undefined) {
        updatePayload.start_date = new Date(dto.start_date);
      }

      if (Object.keys(updatePayload).length > 0) {
        await manager.update(
          FixedExpense,
          { id: String(id), company_id: String(companyId) },
          updatePayload,
        );
      }

      const updated = await manager.findOneOrFail(FixedExpense, {
        where: { id: String(id), company_id: String(companyId) },
      });
      return updated;
    });
  }
}
