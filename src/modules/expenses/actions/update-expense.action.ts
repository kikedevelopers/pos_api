import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { UpdateExpenseDto } from '../dto/update-expense.dto';
import { Expense } from '../entities/expense.entity';
import { findExpenseInCompany } from '../internal/expense-lookups';

/**
 * Actualiza SOLO metadata de un gasto (description, category, notes).
 *
 * NO permite cambios en `amount`, `source_type`, `source_id` ni
 * `expense_date` — cambiarlos exige revertir el movimiento financiero y crear
 * uno nuevo. El frontend debe usar:
 *   1. `DELETE /expenses/:id` (soft-delete, revierte balance).
 *   2. `POST /expenses` (crea uno nuevo con valores correctos).
 *
 * Si el gasto ya fue anulado (`is_archived = true`), rechaza el cambio con
 * 422 — no tiene sentido editar metadata de un row anulado.
 */
@Injectable()
export class UpdateExpenseAction {
  private readonly logger = new Logger(UpdateExpenseAction.name);

  constructor(
    @InjectRepository(Expense)
    private readonly expensesRepo: Repository<Expense>,
  ) {}

  async execute(id: number, dto: UpdateExpenseDto, companyId: number): Promise<Expense> {
    const expense = await findExpenseInCompany(this.expensesRepo.manager, id, companyId);
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

    await this.expensesRepo.update({ id: expense.id, company_id: String(companyId) }, patch);

    this.logger.log({
      event: 'expense.updated',
      companyId,
      expenseId: id,
      patch: Object.keys(patch),
    });

    return findExpenseInCompany(this.expensesRepo.manager, id, companyId);
  }
}
