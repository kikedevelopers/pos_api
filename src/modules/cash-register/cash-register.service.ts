import { Injectable } from '@nestjs/common';

import {
  GetCashRegisterBalanceAction,
  type CashRegisterBalanceResult,
} from './actions/get-balance.action';
import { ListCashRegisterLogsAction } from './actions/list-cash-register-logs.action';
import type { CashRegisterLog } from './entities/cash-register-log.entity';

export type { CashRegisterBalanceResult } from './actions/get-balance.action';

/**
 * Facade del módulo `cash-register`. Sin lógica — solo delega.
 *
 * Las operaciones leen la caja PERMANENTE del actor `(company_id, user_id)`.
 * El `user_id` viene del JWT en el controller y se propaga aquí.
 */
@Injectable()
export class CashRegisterService {
  constructor(
    private readonly getCashRegisterBalanceAction: GetCashRegisterBalanceAction,
    private readonly listCashRegisterLogsAction: ListCashRegisterLogsAction,
  ) {}

  getBalance(companyId: number, userId: number): Promise<CashRegisterBalanceResult> {
    return this.getCashRegisterBalanceAction.execute(companyId, userId);
  }

  listLogs(companyId: number, userId: number, limit?: number): Promise<CashRegisterLog[]> {
    return this.listCashRegisterLogsAction.execute(companyId, userId, limit);
  }
}
