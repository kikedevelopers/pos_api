import { Injectable } from '@nestjs/common';

import { CloseCashRegisterAction } from './actions/close-cash-register.action';
import {
  GetCashRegisterBalanceAction,
  type CashRegisterBalanceResult,
} from './actions/get-balance.action';
import { GetCurrentCashRegisterAction } from './actions/get-current-cash-register.action';
import { ListCashRegisterHistoryAction } from './actions/list-cash-register-history.action';
import { ListCashRegisterLogsAction } from './actions/list-cash-register-logs.action';
import {
  OpenCashRegisterAction,
  type CashRegisterOpener,
} from './actions/open-cash-register.action';
import type { CloseCashRegisterDto } from './dto/close-cash-register.dto';
import type { OpenCashRegisterDto } from './dto/open-cash-register.dto';
import type { CashRegisterLog } from './entities/cash-register-log.entity';
import type { CashRegister } from './entities/cash-register.entity';

export type { CashRegisterOpener } from './actions/open-cash-register.action';
export type { CashRegisterBalanceResult } from './actions/get-balance.action';

/**
 * Facade del módulo `cash-register`. Sin lógica — solo delega.
 */
@Injectable()
export class CashRegisterService {
  constructor(
    private readonly openCashRegisterAction: OpenCashRegisterAction,
    private readonly closeCashRegisterAction: CloseCashRegisterAction,
    private readonly getCurrentCashRegisterAction: GetCurrentCashRegisterAction,
    private readonly listCashRegisterHistoryAction: ListCashRegisterHistoryAction,
    private readonly getCashRegisterBalanceAction: GetCashRegisterBalanceAction,
    private readonly listCashRegisterLogsAction: ListCashRegisterLogsAction,
  ) {}

  open(
    dto: OpenCashRegisterDto,
    companyId: number,
    opener: CashRegisterOpener,
  ): Promise<CashRegister> {
    return this.openCashRegisterAction.execute(dto, companyId, opener);
  }

  close(dto: CloseCashRegisterDto, companyId: number, actorId: number): Promise<CashRegister> {
    return this.closeCashRegisterAction.execute(dto, companyId, actorId);
  }

  getCurrent(companyId: number): Promise<CashRegister | null> {
    return this.getCurrentCashRegisterAction.execute(companyId);
  }

  listHistory(companyId: number, limit?: number): Promise<CashRegister[]> {
    return this.listCashRegisterHistoryAction.execute(companyId, limit);
  }

  getBalance(companyId: number): Promise<CashRegisterBalanceResult> {
    return this.getCashRegisterBalanceAction.execute(companyId);
  }

  listLogs(companyId: number, limit?: number): Promise<CashRegisterLog[]> {
    return this.listCashRegisterLogsAction.execute(companyId, limit);
  }
}
