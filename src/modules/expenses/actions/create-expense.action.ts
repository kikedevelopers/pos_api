import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import type { CreateExpenseDto } from '../dto/create-expense.dto';
import { Expense } from '../entities/expense.entity';
import { debitExpenseSource, type ExpenseActor } from '../internal/debit-expense-source';

/**
 * Registra un gasto administrativo. Espejo de `POST /expenses` de PlacePos
 * adaptado al modelo transaccional NestJS.
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos (dentro de `dataSource.transaction`)
 * --------------------------------------------------------------------------
 *
 *   1. Resolver y debitar la fuente (`debitExpenseSource`):
 *        - `bank` / `wallet`: lock pessimistic_write, validar
 *          `balance >= amount`, UPDATE balance.
 *        - `cash_register`: requireOpenCashRegisterForUpdate (lock), validar
 *          balance computado contra logs, INSERT CashRegisterLog(CASH_OUT).
 *
 *   2. INSERT `expenses` con `source_name` snapshot.
 *
 *   3. INSERT `FinancialMovement(EXPENSE, concept = EXPENSE)` salvo cuando la
 *      fuente es cash_register: en ese caso el CashRegisterLog ya cumple la
 *      función de pista de auditoría (paridad PlacePos: PlacePos NO genera
 *      FinancialMovement para gastos de caja — solo log).
 *
 *      **Divergencia documentada**: en este cloud generamos FinancialMovement
 *      TAMBIÉN para gastos pagados desde bancos/wallets (donde no hay log).
 *      Eso permite que los reportes de financial-movements muestren los
 *      gastos como salida de cuenta. Para cash_register, evitamos el row
 *      duplicado.
 *
 * Si CUALQUIER paso falla → rollback total.
 *
 * Multi-tenancy: `company_id` siempre viene del JWT (parámetro), nunca del
 * payload. Las cuentas (bank/wallet/cash_register) se validan dentro del
 * tenant en el helper `debitExpenseSource`.
 */
@Injectable()
export class CreateExpenseAction {
  private readonly logger = new Logger(CreateExpenseAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(dto: CreateExpenseDto, companyId: number, actor: ExpenseActor): Promise<Expense> {
    const amountBig: Big = toBig(dto.amount);
    if (amountBig.lte(0)) {
      throw new UnprocessableEntityException('amount debe ser mayor a cero');
    }
    const amount = preciseNumber(amountBig, 2);

    return this.dataSource.transaction<Expense>(async (manager) => {
      // 1. Resolver y debitar la fuente con lock + validación de balance.
      const { sourceName, resolvedSourceId } = await debitExpenseSource(
        manager,
        dto.source_type,
        dto.source_id,
        companyId,
        amountBig,
        actor,
      );

      // 2. INSERT Expense.
      const expense = manager.create(Expense, {
        company_id: String(companyId),
        description: dto.description.trim(),
        amount,
        category: dto.category ?? null,
        source_type: dto.source_type,
        source_id: String(resolvedSourceId),
        source_name: sourceName,
        expense_date: dto.expense_date ? new Date(dto.expense_date) : new Date(),
        notes: dto.notes ?? null,
        is_archived: false,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });
      const saved = await manager.save(Expense, expense);

      // 3. FinancialMovement — solo para bank/wallet (cash_register ya quedó
      //    registrado en CashRegisterLog dentro del helper).
      //
      //    El movimiento solo tiene `source` (la cuenta de la que sale el
      //    dinero). NO seteamos `destination_*` porque el destino es externo
      //    al sistema y los CHECKs `chk_financial_movements_*_consistency`
      //    exigen que (type, id) sean ambos NULL o ambos NOT NULL. El CHECK
      //    `chk_financial_movements_has_endpoint` se satisface con el source.
      if (dto.source_type !== 'cash_register') {
        await this.financialMovementsService.record(manager, {
          companyId,
          amount,
          movement_type: MovementType.EXPENSE,
          concept: MovementConcept.EXPENSE,
          description: `Gasto: ${dto.description.trim()}`,
          source_type: dto.source_type,
          source_id: resolvedSourceId,
          reference_code: `EXP-${String(saved.id)}`,
          created_by: actor.fullName,
          created_by_id: actor.id,
        });
      }

      this.logger.log({
        event: 'expense.created',
        companyId,
        expenseId: Number(saved.id),
        sourceType: dto.source_type,
        sourceId: resolvedSourceId,
        amount,
        actorId: actor.id,
      });

      return saved;
    });
  }
}
