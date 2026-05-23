import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import {
  GetCashRegisterBalanceAction,
  type CashRegisterBalanceResult,
} from './actions/get-balance.action';
import { ListCashRegisterLogsAction } from './actions/list-cash-register-logs.action';
import {
  RecordCashRegisterLogAction,
  type RecordCashRegisterLogInput,
  type RecordCashRegisterLogResult,
} from './actions/record-cash-register-log.action';
import type { CashRegisterLog } from './entities/cash-register-log.entity';

export type { CashRegisterBalanceResult } from './actions/get-balance.action';
export type {
  RecordCashRegisterLogInput,
  RecordCashRegisterLogResult,
} from './actions/record-cash-register-log.action';

/**
 * Facade del módulo `cash-register`. Sin lógica — solo delega.
 *
 * Las operaciones leen la caja PERMANENTE del actor `(company_id, user_id)`.
 * El `user_id` viene del JWT en el controller y se propaga aquí.
 *
 * El método `record(manager, input)` se expone para que otros módulos
 * (accounts, sales, expenses, etc.) inyecten el service y registren logs +
 * mutación atómica del balance DENTRO de sus propias transacciones. La firma
 * exige el `manager` para forzar atomicidad.
 */
@Injectable()
export class CashRegisterService {
  constructor(
    private readonly getCashRegisterBalanceAction: GetCashRegisterBalanceAction,
    private readonly listCashRegisterLogsAction: ListCashRegisterLogsAction,
    private readonly recordCashRegisterLogAction: RecordCashRegisterLogAction,
  ) {}

  getBalance(companyId: number, userId: number): Promise<CashRegisterBalanceResult> {
    return this.getCashRegisterBalanceAction.execute(companyId, userId);
  }

  listLogs(companyId: number, userId: number, limit?: number): Promise<CashRegisterLog[]> {
    return this.listCashRegisterLogsAction.execute(companyId, userId, limit);
  }

  record(
    manager: EntityManager,
    input: RecordCashRegisterLogInput,
  ): Promise<RecordCashRegisterLogResult> {
    return this.recordCashRegisterLogAction.execute(manager, input);
  }
}
