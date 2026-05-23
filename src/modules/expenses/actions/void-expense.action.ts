import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { Expense } from '../entities/expense.entity';
import { creditExpenseSource, type ExpenseActor } from '../internal/debit-expense-source';
import { findExpenseInCompany } from '../internal/expense-lookups';

/**
 * Anula un gasto. Endpoint `POST /expenses/:id/void` — espejo PlacePos.
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos
 * --------------------------------------------------------------------------
 *
 *   1. Cargar Expense con lock implícito (re-leído al final de la tx).
 *      Rechaza si ya está archivado (idempotencia inversa: no
 *      revertir dos veces).
 *
 *   2. Acreditar la cuenta origen (`creditExpenseSource`):
 *        - bank / wallet: lock pessimistic_write + UPDATE balance += amount.
 *          Falla si la cuenta fue archivada.
 *        - cash_register: getOrCreateCashRegisterForUser del actor +
 *          UPDATE balance += amount + INSERT CashRegisterLog(VOID_EXPENSE).
 *
 *   3. UPDATE Expense SET is_archived = true.
 *
 *   4. INSERT FinancialMovement(INCOME, concept=ADJUSTMENT) salvo cuando la
 *      fuente es cash_register (el log de CASH_IN ya cumple la función).
 *
 * Si CUALQUIER paso falla → rollback total.
 *
 * Multi-tenancy: `findExpenseInCompany` valida que el row pertenece al
 * tenant. La cuenta origen se valida nuevamente en `creditExpenseSource`.
 */
@Injectable()
export class VoidExpenseAction {
  private readonly logger = new Logger(VoidExpenseAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(id: number, companyId: number, actor: ExpenseActor): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const expense = await findExpenseInCompany(manager, id, companyId);
      if (expense.is_archived) {
        throw new UnprocessableEntityException('El gasto ya fue anulado');
      }

      const amountBig = toBig(expense.amount);

      // 1. Revertir balance de la fuente.
      await creditExpenseSource(
        manager,
        expense.source_type,
        Number(expense.source_id),
        companyId,
        amountBig,
        actor,
      );

      // 2. Marcar archived.
      await manager.update(
        Expense,
        { id: expense.id, company_id: String(companyId) },
        { is_archived: true },
      );

      // 3. Financial movement reversal (solo para bank/wallet — cash_register
      //    ya tiene su CashRegisterLog de VOID_EXPENSE/IN).
      //
      //    `concept = REFUND` (paridad PlacePos `expenses.routes.ts`).
      //    Descripción "Anulación de gasto: ..." replica byte-a-byte el
      //    texto que graba PlacePos para que cualquier reporte cruzado se
      //    vea idéntico.
      if (expense.source_type !== 'cash_register') {
        await this.financialMovementsService.record(manager, {
          companyId,
          amount: Number(expense.amount),
          movement_type: MovementType.INCOME,
          concept: MovementConcept.REFUND,
          description: `Anulación de gasto: ${expense.description}`,
          // El "ingreso" entra a la misma cuenta de la que salió. PlacePos
          // pone source=NULL+destination=cuenta. Mismo patrón aquí.
          destination_type: expense.source_type,
          destination_id: Number(expense.source_id),
          reference_code: `EXP-VOID-${String(expense.id)}`,
          created_by: actor.fullName,
          created_by_id: actor.id,
        });
      }

      this.logger.log({
        event: 'expense.voided',
        companyId,
        expenseId: id,
        sourceType: expense.source_type,
        sourceId: Number(expense.source_id),
        amount: Number(expense.amount),
        actorId: actor.id,
      });
    });
  }
}
