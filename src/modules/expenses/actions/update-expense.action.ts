import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateExpenseDto } from '../dto/update-expense.dto';
import { Expense } from '../entities/expense.entity';
import { findExpenseInCompany } from '../internal/expense-lookups';

/**
 * Actualiza SOLO metadata de un gasto (description, category, notes).
 *
 * NO permite cambios en `amount`, `source_type`, `source_id` ni
 * `expense_date` — cambiarlos exige revertir el movimiento financiero y crear
 * uno nuevo. El frontend debe usar:
 *   1. `POST /expenses/:id/void` (anula el gasto y revierte el balance).
 *   2. `POST /expenses` (crea uno nuevo con valores correctos).
 *
 * Si el gasto ya fue anulado (`is_archived = true`), rechaza el cambio con
 * 422 — no tiene sentido editar metadata de un row anulado.
 *
 * Transacción: §8.8 CLAUDE.md — toda mutación va dentro de
 * `dataSource.transaction`. Aquí lookup + update + re-read viven en el mismo
 * manager para garantizar atomicidad si en el futuro se añaden side-effects
 * (audit log, hooks).
 */
@Injectable()
export class UpdateExpenseAction {
  private readonly logger = new Logger(UpdateExpenseAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateExpenseDto, companyId: number): Promise<Expense> {
    return this.dataSource.transaction<Expense>(async (manager) => {
      const expense = await findExpenseInCompany(manager, id, companyId);
      if (expense.is_archived) {
        throw new UnprocessableEntityException(
          'No se puede editar un gasto anulado. Registra uno nuevo.',
        );
      }

      const patch: Partial<Expense> = {};
      if (dto.description !== undefined) {
        patch.description = dto.description.trim();
      }
      if (dto.category !== undefined) {
        // Permite null explícito para limpiar la categoría.
        patch.category = dto.category;
      }
      if (dto.notes !== undefined) {
        patch.notes = dto.notes;
      }

      if (Object.keys(patch).length === 0) {
        // No-op: devuelve el row tal cual.
        return expense;
      }

      await manager.update(Expense, { id: expense.id, company_id: String(companyId) }, patch);

      this.logger.log({
        event: 'expense.updated',
        companyId,
        expenseId: id,
        patch: Object.keys(patch),
      });

      return findExpenseInCompany(manager, id, companyId);
    });
  }
}
