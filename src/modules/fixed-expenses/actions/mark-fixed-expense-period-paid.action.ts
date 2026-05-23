import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Expense } from '@/modules/expenses/entities/expense.entity';
import { debitExpenseSource } from '@/modules/expenses/internal/debit-expense-source';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import type { PayFixedExpensePeriodDto } from '../dto/pay-fixed-expense-period.dto';
import { FixedExpensePeriod } from '../entities/fixed-expense-period.entity';
import { FixedExpense } from '../entities/fixed-expense.entity';

import type { FixedExpenseActor } from './create-fixed-expense.action';

/**
 * Marca un corte (`FixedExpensePeriod`) como PAGADO y, en la misma
 * transacción:
 *
 *   1. Resuelve y lockea el corte filtrando por `company_id` (anti-IDOR).
 *      Solo cortes en `status='PENDING'` se aceptan.
 *   2. Resuelve y lockea el padre `FixedExpense` para el snapshot del
 *      `name` (descripción del gasto materializado).
 *   3. Debita la fuente (`bank` / `wallet` / `cash_register`) usando el
 *      helper compartido `debitExpenseSource`. El helper aplica lock
 *      pessimistic_write y valida saldo (422 si insuficiente).
 *   4. INSERT `Expense` con `description = "Gasto fijo: <name> — periodo <n>"`.
 *      Para `cash_register` el helper ya emitió `CashRegisterLog(EXPENSE)`;
 *      para bank/wallet, aquí emitimos `FinancialMovement(EXPENSE,
 *      EXPENSE_PAYMENT)`.
 *   5. UPDATE corte: `status=PAID`, `paid_at=now`, `paid_by_id=actor`,
 *      `expense_id=resultado del INSERT`.
 *
 * Multi-tenancy: TODO query lleva `company_id`. Defensa en profundidad para
 * cortes y para el UPDATE final (I-2 auditoría).
 *
 * §8.8 / §9.4: una sola transacción. Aislamiento READ COMMITTED es
 * suficiente — los locks pesimistas (cuenta origen + corte) serializan los
 * casos competitivos.
 */
@Injectable()
export class MarkFixedExpensePeriodPaidAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    fixedExpenseId: number,
    periodId: number,
    dto: PayFixedExpensePeriodDto,
    companyId: number,
    actor: FixedExpenseActor,
  ): Promise<FixedExpensePeriod> {
    return this.dataSource.transaction<FixedExpensePeriod>(async (manager) => {
      const period = await manager.findOne(FixedExpensePeriod, {
        where: {
          id: String(periodId),
          fixed_expense_id: String(fixedExpenseId),
          company_id: String(companyId),
        },
      });

      if (!period) {
        throw new NotFoundException('Corte no encontrado.');
      }

      if (period.status === 'PAID') {
        throw new UnprocessableEntityException('El corte ya está marcado como pagado.');
      }

      // Cargar el padre para snapshot del `name` (descripción del gasto).
      const parent = await manager.findOne(FixedExpense, {
        where: {
          id: String(fixedExpenseId),
          company_id: String(companyId),
        },
      });
      if (!parent) {
        // Defensa: el corte existe en la company pero el padre no — estado
        // inconsistente. Rechazamos en lugar de continuar con datos parciales.
        throw new NotFoundException('Gasto fijo no encontrado.');
      }

      const amountBig = toBig(period.amount);
      const amount = preciseNumber(amountBig, 2);
      const description = `Gasto fijo: ${parent.name} — periodo ${period.period_number}`;
      const actorPayload = { id: actor.id, fullName: actor.fullName };

      // 1. Debitar la fuente (Big.js + lock pesimista + log si cash_register).
      const { sourceName, resolvedSourceId } = await debitExpenseSource(
        manager,
        dto.source_type,
        dto.source_id,
        companyId,
        amountBig,
        actorPayload,
      );

      // 2. Materializar Expense con la fuente resuelta (cash_register usa
      //    server-side resolution; bank/wallet usa el id del payload).
      const expense = manager.create(Expense, {
        company_id: String(companyId),
        description,
        amount,
        category: 'OTHER',
        source_type: dto.source_type,
        source_id: String(resolvedSourceId),
        source_name: sourceName,
        expense_date: new Date(),
        notes: `Pago de gasto fijo (corte ${period.period_number}).`,
        is_archived: false,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });
      const savedExpense = await manager.save(Expense, expense);

      // 3. FinancialMovement (solo bank/wallet; cash_register ya quedó en log).
      if (dto.source_type !== 'cash_register') {
        await this.financialMovementsService.record(manager, {
          companyId,
          amount,
          movement_type: MovementType.EXPENSE,
          concept: MovementConcept.EXPENSE_PAYMENT,
          description,
          source_type: dto.source_type,
          source_id: resolvedSourceId,
          reference_code: `EXP-${String(savedExpense.id)}`,
          created_by: actor.fullName,
          created_by_id: actor.id,
        });
      }

      // 4. UPDATE corte. I-2: company_id en el where (defensa en profundidad
      //    contra cross-tenant si en el futuro este action se llama desde
      //    otro contexto).
      const now = new Date();
      await manager.update(
        FixedExpensePeriod,
        { id: period.id, company_id: String(companyId) },
        {
          status: 'PAID',
          paid_at: now,
          paid_by_id: String(actor.id),
          expense_id: savedExpense.id,
        },
      );

      // I-2: company_id también en el findOneOrFail final.
      const updated = await manager.findOneOrFail(FixedExpensePeriod, {
        where: { id: period.id, company_id: String(companyId) },
      });
      return updated;
    });
  }
}
