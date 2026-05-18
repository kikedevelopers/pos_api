import { Injectable } from '@nestjs/common';

import {
  CloseCashAction,
  type CloseCashActor,
  type CloseCashResult,
} from './actions/close-cash.action';
import { GetCashSummaryAction, type CashSummaryResult } from './actions/get-cash-summary.action';
import { GetCustomersAction, type PosCustomer } from './actions/get-customers.action';
import { GetItemsAction, type PosItem } from './actions/get-items.action';
import { GetPaymentBanksAction, type PosPaymentBank } from './actions/get-payment-banks.action';
import {
  GetPosTransferDestinationsAction,
  type PosDataDestinationsPayload,
} from './actions/get-transfer-destinations.action';
import {
  TransferCashAction,
  type TransferCashActor,
  type TransferCashResult,
} from './actions/transfer-cash.action';
import type { CloseCashDto } from './dto/close-cash.dto';
import type { TransferCashDto } from './dto/transfer-cash.dto';

export type {
  CashSummaryResult,
  CloseCashActor,
  CloseCashResult,
  PosCustomer,
  PosDataDestinationsPayload,
  PosItem,
  PosPaymentBank,
  TransferCashResult,
};

/**
 * Facade del módulo `pos-data`. ZERO lógica — solo delega a las actions.
 */
@Injectable()
export class PosDataService {
  constructor(
    private readonly getItems: GetItemsAction,
    private readonly getCustomers: GetCustomersAction,
    private readonly getPaymentBanks: GetPaymentBanksAction,
    private readonly getTransferDestinations: GetPosTransferDestinationsAction,
    private readonly transferCash: TransferCashAction,
    private readonly closeCash: CloseCashAction,
    private readonly getCashSummary: GetCashSummaryAction,
  ) {}

  items(companyId: number): Promise<PosItem[]> {
    return this.getItems.execute(companyId);
  }

  customers(companyId: number): Promise<PosCustomer[]> {
    return this.getCustomers.execute(companyId);
  }

  paymentBanks(companyId: number): Promise<PosPaymentBank[]> {
    return this.getPaymentBanks.execute(companyId);
  }

  transferDestinations(companyId: number): Promise<PosDataDestinationsPayload> {
    return this.getTransferDestinations.execute(companyId);
  }

  doTransferCash(
    dto: TransferCashDto,
    companyId: number,
    actor: TransferCashActor,
  ): Promise<TransferCashResult> {
    return this.transferCash.execute(dto, companyId, actor);
  }

  doCloseCash(
    dto: CloseCashDto,
    companyId: number,
    actor: CloseCashActor,
    idempotencyKey: string | null = null,
  ): Promise<CloseCashResult> {
    return this.closeCash.execute(dto, companyId, actor, idempotencyKey);
  }

  cashSummary(companyId: number, userId: number): Promise<CashSummaryResult> {
    return this.getCashSummary.execute(companyId, userId);
  }
}
