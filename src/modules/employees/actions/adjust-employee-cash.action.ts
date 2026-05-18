import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { findEmployeeInCompany } from '../internal/employee-lookups';
import { getOrCreateEmployeeCashRegister } from '../internal/employee-cash-register-lookup';

/**
 * Actor (snapshot del usuario que origina el ajuste).
 */
export interface AdjustEmployeeCashActor {
  id: number;
  fullName: string;
}

/**
 * Resultado del endpoint `POST /employees/:id/cash-register/adjust`.
 *
 * Shape (espejo PlacePos):
 *
 *   {
 *     employee_id,
 *     previous_balance,
 *     new_balance,
 *     difference,   // diff = new - previous (puede ser negativo)
 *     movement: <FinancialMovement>,
 *     log: <CashRegisterLog>,
 *   }
 *
 * Si la diff es exactamente 0, NO se generan log/movement (no-op idempotente)
 * y los campos `movement`/`log` quedan en `null`.
 */
export interface AdjustEmployeeCashResult {
  employee_id: number;
  previous_balance: number;
  new_balance: number;
  difference: number;
  movement: unknown | null;
  log: unknown | null;
}

/**
 * Operación admin del owner: define cuánto DEBE quedar la caja del empleado.
 *
 * --------------------------------------------------------------------------
 * Modelo PERMANENTE
 * --------------------------------------------------------------------------
 *
 *   1. Resolver employee + su CashRegister `(company_id, employee.user_id)`
 *      con lock pessimistic_write.
 *   2. `diff = target_balance - register.balance` (Big.js).
 *   3. Si `diff.eq(0)` → no-op, devuelve estado actual.
 *   4. Caso contrario:
 *        - UPDATE register.balance = target_balance.
 *        - direction = diff > 0 ? 'IN' : 'OUT'.
 *        - movement_type = diff > 0 ? INCOME : EXPENSE.
 *        - INSERT CashRegisterLog(type=ADMIN_ADJUSTMENT, direction,
 *          amount=|diff|, affects_balance=true, description con razón).
 *        - INSERT FinancialMovement(concept=ADJUSTMENT, type=INCOME/EXPENSE,
 *          reference_code=uuidv4(), source/destination='cash_register').
 *
 * --------------------------------------------------------------------------
 * Resolución del User espejo (Fase 4A)
 * --------------------------------------------------------------------------
 *
 * `employee.user_id` puede estar null si el employee tiene `login_enabled
 * = true` pero nunca autenticó. `getOrCreateEmployeeCashRegister` lo
 * materializa on-the-fly en ese caso. Si el employee no tiene login
 * habilitado, lanza 422 `EMPLOYEE_HAS_NO_CASH_REGISTER`.
 */
@Injectable()
export class AdjustEmployeeCashAction {
  private readonly logger = new Logger(AdjustEmployeeCashAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    id: number,
    companyId: number,
    targetBalance: number,
    reason: string | undefined,
    actor: AdjustEmployeeCashActor,
  ): Promise<AdjustEmployeeCashResult> {
    return this.dataSource.transaction<AdjustEmployeeCashResult>(async (manager) => {
      const employee = await findEmployeeInCompany(manager, id, companyId);
      const register = await getOrCreateEmployeeCashRegister(manager, employee, companyId);

      const currentBig = toBig(register.balance);
      const targetBig = toBig(targetBalance);
      const diffBig = targetBig.minus(currentBig);
      const previous = preciseNumber(currentBig, 2);
      const newBalance = preciseNumber(targetBig, 2);
      const difference = preciseNumber(diffBig, 2);

      // No-op idempotente: si el balance ya coincide, no generamos rows.
      if (diffBig.eq(0)) {
        return {
          employee_id: Number(employee.id),
          previous_balance: previous,
          new_balance: newBalance,
          difference: 0,
          movement: null,
          log: null,
        };
      }

      const absAmount = preciseNumber(diffBig.abs(), 2);
      const direction: 'IN' | 'OUT' = diffBig.gt(0) ? 'IN' : 'OUT';
      const movementType = direction === 'IN' ? MovementType.INCOME : MovementType.EXPENSE;
      const description = reason?.trim() || 'Ajuste administrativo';
      const referenceCode = `ADJ-${randomUUID()}`;

      // 1. UPDATE balance directo al target.
      await manager.update(
        CashRegister,
        { id: register.id, company_id: String(companyId) },
        { balance: newBalance },
      );

      // 2. CashRegisterLog (afecta balance — documental).
      const log = manager.create(CashRegisterLog, {
        company_id: String(companyId),
        cash_register_id: register.id,
        type: CashRegisterLogType.ADMIN_ADJUSTMENT,
        direction,
        amount: absAmount,
        affects_balance: true,
        description,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });
      const savedLog = await manager.save(CashRegisterLog, log);

      // 3. FinancialMovement. Source = cash_register cuando es OUT, destination
      //    = cash_register cuando es IN.
      const movement = await this.financialMovementsService.record(manager, {
        companyId,
        amount: absAmount,
        movement_type: movementType,
        concept: MovementConcept.ADJUSTMENT,
        description,
        source_type: direction === 'OUT' ? 'cash_register' : null,
        source_id: direction === 'OUT' ? Number(register.id) : null,
        destination_type: direction === 'IN' ? 'cash_register' : null,
        destination_id: direction === 'IN' ? Number(register.id) : null,
        reference_code: referenceCode,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });

      this.logger.log({
        event: 'employee.cash_adjusted',
        companyId,
        employeeId: Number(employee.id),
        cashRegisterId: Number(register.id),
        previousBalance: previous,
        newBalance,
        difference,
        actorId: actor.id,
      });

      return {
        employee_id: Number(employee.id),
        previous_balance: previous,
        new_balance: newBalance,
        difference,
        movement,
        log: savedLog,
      };
    });
  }
}
