import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import Big from 'big.js';
import { DataSource, In } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Expense } from '@/modules/expenses/entities/expense.entity';
import {
  debitExpenseSource,
  type ExpenseActor,
} from '@/modules/expenses/internal/debit-expense-source';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import type { PayFixedExpensePeriodsDto } from '../dto/pay-fixed-expense-periods.dto';
import {
  FixedExpensePeriod,
  type FixedExpensePeriodStatus,
} from '../entities/fixed-expense-period.entity';
import { FixedExpense } from '../entities/fixed-expense.entity';

import type { FixedExpenseActor } from './create-fixed-expense.action';

export interface PayFixedExpensePeriodsResult {
  /** TODOS los cortes del gasto, ya actualizados (orden period_number ASC). */
  periods: FixedExpensePeriod[];
  /** Monto total efectivamente aplicado. */
  paid_total: number;
}

/**
 * Pago parcial/total multi-corte de un gasto fijo (§4 del contrato
 * `CONTRACT_fixed_expense_periods_pay.md`).
 *
 * Generaliza `MarkFixedExpensePeriodPaidAction` (pago total de 1 corte) a:
 *   - varios cortes en una sola operación,
 *   - montos parciales,
 *   - asignación automática del corte MÁS ANTIGUO al más nuevo.
 *
 * --------------------------------------------------------------------------
 * Algoritmo de asignación (canónico, transacción única, READ COMMITTED)
 * --------------------------------------------------------------------------
 *
 *   1. Validar `amount > 0` y `period_ids` no vacío (lo hace el DTO; aquí se
 *      re-valida en Big para blindaje).
 *   2. Cargar los cortes seleccionados de ESTE gasto + company, ordenados por
 *      `period_number ASC`. Si algún id no pertenece al gasto/company → 404
 *      (no se filtra silenciosamente: el cliente envió algo inconsistente).
 *      Para la asignación solo se consideran los de `balance > 0`.
 *   3. `totalBalance = Σ balance(seleccionados con balance>0)`. Si
 *      `amount > totalBalance` → 400 "El monto excede el saldo de los cortes
 *      seleccionados".
 *   4. `remaining = amount` (Big). Para cada corte en orden:
 *        - `alloc = min(remaining, corte.balance)`; si `alloc <= 0` romper.
 *        - Debitar la fuente por `alloc` (lock pesimista; 422 si saldo
 *          insuficiente) vía `debitExpenseSource`.
 *        - Materializar `Expense` (amount=alloc) con descripción
 *          "Gasto fijo: <name> — periodo <n>". Enlazar `corte.expense_id`.
 *        - bank/wallet → `FinancialMovement(EXPENSE/EXPENSE_PAYMENT)`
 *          (cash_register ya quedó en `CashRegisterLog` dentro del helper).
 *        - UPDATE corte: `paid_amount += alloc`, `balance -= alloc`,
 *          `status = balance==0 ? 'PAID' : 'PARTIALLY_PAID'`; si PAID setear
 *          `paid_at=now`, `paid_by_id=actor`.
 *        - `remaining -= alloc`; si `remaining == 0` romper.
 *   5. Commit. Devolver TODOS los cortes del gasto actualizados + `paid_total`.
 *
 * Multi-tenancy: TODO query lleva `company_id` (defensa en profundidad).
 * Aislamiento READ COMMITTED es suficiente — los locks pesimistas (cuenta
 * origen) serializan los casos competitivos sobre el saldo de la fuente; cada
 * corte se debita y actualiza una sola vez dentro de la transacción.
 */
@Injectable()
export class PayFixedExpensePeriodsAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    fixedExpenseId: number,
    dto: PayFixedExpensePeriodsDto,
    companyId: number,
    actor: FixedExpenseActor,
  ): Promise<PayFixedExpensePeriodsResult> {
    const amountBig = toBig(dto.amount);
    if (amountBig.lte(0)) {
      throw new BadRequestException('El monto a pagar debe ser mayor que cero.');
    }
    if (dto.period_ids.length === 0) {
      throw new BadRequestException('Debe seleccionarse al menos un corte.');
    }

    // bank/wallet requieren source_id explícito; cash_register lo ignora.
    const sourceId = dto.source_type === 'cash_register' ? actor.id : dto.source_id;
    if (dto.source_type !== 'cash_register' && (sourceId === undefined || sourceId === null)) {
      throw new BadRequestException(
        'Debe seleccionarse una cuenta (banco o billetera) para el pago.',
      );
    }

    return this.dataSource.transaction<PayFixedExpensePeriodsResult>(async (manager) => {
      // 1. Cargar el padre (snapshot del name + anti-IDOR).
      const parent = await manager.findOne(FixedExpense, {
        where: { id: String(fixedExpenseId), company_id: String(companyId) },
      });
      if (!parent) {
        throw new NotFoundException('Gasto fijo no encontrado.');
      }

      // 2. Cargar los cortes seleccionados de este gasto + company, con lock para
      //    serializar pagos concurrentes sobre los mismos cortes.
      const selected = await manager.find(FixedExpensePeriod, {
        where: {
          id: In(dto.period_ids.map(String)),
          fixed_expense_id: String(fixedExpenseId),
          company_id: String(companyId),
        },
        order: { period_number: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });

      // Rechazar si algún id no pertenece al gasto/company (no filtrar silencioso).
      if (selected.length !== dto.period_ids.length) {
        throw new NotFoundException(
          'Uno o más cortes seleccionados no existen en este gasto fijo.',
        );
      }

      // Solo se asignan los que tienen saldo (los ya PAID se ignoran).
      const payable = selected.filter((p) => toBig(p.balance).gt(0));

      const totalBalance = payable.reduce((acc, p) => acc.plus(toBig(p.balance)), new Big(0));
      if (totalBalance.lte(0)) {
        throw new BadRequestException('Los cortes seleccionados no tienen saldo pendiente.');
      }
      if (amountBig.gt(totalBalance)) {
        throw new BadRequestException('El monto excede el saldo de los cortes seleccionados.');
      }

      const actorPayload: ExpenseActor = { id: actor.id, fullName: actor.fullName };
      const now = new Date();
      let remaining = amountBig;
      const updatedIds: string[] = [];

      // 3. Repartir del más antiguo al más nuevo.
      for (const period of payable) {
        if (remaining.lte(0)) {
          break;
        }
        const periodBalance = toBig(period.balance);
        const alloc = remaining.gt(periodBalance) ? periodBalance : remaining;
        if (alloc.lte(0)) {
          break;
        }
        const allocNum = preciseNumber(alloc, 2);

        const description = `Gasto fijo: ${parent.name} — periodo ${period.period_number}`;

        // a. Debitar la fuente (Big.js + lock pesimista + log si cash_register).
        const { sourceName, resolvedSourceId } = await debitExpenseSource(
          manager,
          dto.source_type,
          sourceId as number,
          companyId,
          alloc,
          actorPayload,
        );

        // b. Materializar Expense por la porción asignada a este corte.
        const expense = manager.create(Expense, {
          company_id: String(companyId),
          description,
          amount: allocNum,
          category: 'OTHER',
          source_type: dto.source_type,
          source_id: String(resolvedSourceId),
          source_name: sourceName,
          expense_date: now,
          notes: `Pago de gasto fijo (corte ${period.period_number}).`,
          is_archived: false,
          // Marca de origen FIJO: excluye esta fila de los "gastos del día" que
          // restan de la ganancia (el débito a la fuente ya bajó el saldo) y del
          // listado de gastos variables. Solo visible en el módulo de Gastos Fijos.
          is_fixed: true,
          // Enlace al corte para reconstruir total/saldo/vencimiento en el cierre.
          fixed_expense_period_id: period.id,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        });
        const savedExpense = await manager.save(Expense, expense);

        // c. FinancialMovement (solo bank/wallet; cash_register ya quedó en log).
        if (dto.source_type !== 'cash_register') {
          await this.financialMovementsService.record(manager, {
            companyId,
            amount: allocNum,
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

        // d. Actualizar el corte con Big.js.
        //
        //    C6: derivamos `balance` de `amount - newPaid` (ambos ya redondeados)
        //    en lugar de redondear `paid_amount` y `balance` por separado. Si un
        //    futuro `alloc` tuviera 3+ decimales (p.ej. una división), redondear
        //    cada uno por su lado podría romper el invariante DB
        //    `paid_amount + balance = amount` y abortar la transacción. Al derivar
        //    uno del otro, la suma SIEMPRE cierra exactamente contra `amount`.
        const periodAmount = toBig(period.amount);
        const newPaid = preciseNumber(toBig(period.paid_amount).plus(alloc), 2);
        const newBalance = preciseNumber(periodAmount.minus(newPaid), 2);
        const isPaid = newBalance <= 0;
        const newStatus: FixedExpensePeriodStatus = isPaid ? 'PAID' : 'PARTIALLY_PAID';

        await manager.update(
          FixedExpensePeriod,
          { id: period.id, company_id: String(companyId) },
          {
            paid_amount: newPaid,
            balance: newBalance,
            status: newStatus,
            // expense_id apunta al ÚLTIMO Expense que tocó el corte (back-compat
            // con el endpoint viejo que enlazaba 1:1). paid_at/paid_by solo al
            // quedar PAID.
            expense_id: savedExpense.id,
            ...(isPaid ? { paid_at: now, paid_by_id: String(actor.id) } : {}),
          },
        );

        updatedIds.push(period.id);
        remaining = remaining.minus(alloc);
      }

      const paidTotal = preciseNumber(amountBig.minus(remaining), 2);

      // 4. Devolver TODOS los cortes del gasto actualizados (para refrescar el modal).
      const periods = await manager.find(FixedExpensePeriod, {
        where: {
          fixed_expense_id: String(fixedExpenseId),
          company_id: String(companyId),
        },
        order: { period_number: 'ASC' },
      });

      return { periods, paid_total: paidTotal };
    });
  }
}
