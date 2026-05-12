import { Injectable } from '@nestjs/common';

import { CreatePurchaseAction, type PurchaseCreator } from './actions/create-purchase.action';
import { FindAllPurchasesAction, type PurchaseListItem } from './actions/find-all-purchases.action';
import { FindPurchaseAction, type PurchaseAggregate } from './actions/find-purchase.action';
import { FindPurchasesBySupplierAction } from './actions/find-purchases-by-supplier.action';
import { ListPurchasePaymentsAction } from './actions/list-purchase-payments.action';
import { MarkPurchaseReceivedAction } from './actions/mark-purchase-received.action';
import {
  RegisterPurchasePaymentAction,
  type PurchasePaymentActor,
  type RegisterPurchasePaymentResult,
} from './actions/register-purchase-payment.action';
import { SoftDeletePurchaseAction } from './actions/soft-delete-purchase.action';
import type { CreatePurchasePaymentDto } from './dto/create-purchase-payment.dto';
import type { CreatePurchaseDto } from './dto/create-purchase.dto';
import type { ReceivePurchaseDto } from './dto/receive-purchase.dto';
import type { Purchase } from './entities/purchase.entity';
import type { PurchasePayment } from './entities/purchase-payment.entity';

export type { PurchaseCreator } from './actions/create-purchase.action';
export type {
  PurchasePaymentActor,
  RegisterPurchasePaymentResult,
} from './actions/register-purchase-payment.action';
export type { PurchaseAggregate } from './actions/find-purchase.action';
export type { PurchaseListItem } from './actions/find-all-purchases.action';

/**
 * Facade del módulo `purchases`. ZERO lógica — solo delega.
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly findAllPurchasesAction: FindAllPurchasesAction,
    private readonly findPurchaseAction: FindPurchaseAction,
    private readonly findPurchasesBySupplierAction: FindPurchasesBySupplierAction,
    private readonly createPurchaseAction: CreatePurchaseAction,
    private readonly markPurchaseReceivedAction: MarkPurchaseReceivedAction,
    private readonly softDeletePurchaseAction: SoftDeletePurchaseAction,
    private readonly registerPurchasePaymentAction: RegisterPurchasePaymentAction,
    private readonly listPurchasePaymentsAction: ListPurchasePaymentsAction,
  ) {}

  findAll(companyId: number, showAll = false): Promise<PurchaseListItem[]> {
    return this.findAllPurchasesAction.execute(companyId, showAll);
  }

  findOne(id: number, companyId: number): Promise<PurchaseAggregate> {
    return this.findPurchaseAction.execute(id, companyId);
  }

  findBySupplier(supplierId: number, companyId: number): Promise<Purchase[]> {
    return this.findPurchasesBySupplierAction.execute(supplierId, companyId);
  }

  create(
    dto: CreatePurchaseDto,
    companyId: number,
    createdBy: PurchaseCreator,
  ): Promise<PurchaseAggregate> {
    return this.createPurchaseAction.execute(dto, companyId, createdBy);
  }

  markReceived(
    id: number,
    dto: ReceivePurchaseDto,
    companyId: number,
    actorId: number,
  ): Promise<PurchaseAggregate> {
    return this.markPurchaseReceivedAction.execute(id, dto, companyId, actorId);
  }

  softDelete(id: number, companyId: number, actorId: number): Promise<void> {
    return this.softDeletePurchaseAction.execute(id, companyId, actorId);
  }

  registerPayment(
    purchaseId: number,
    dto: CreatePurchasePaymentDto,
    companyId: number,
    actor: PurchasePaymentActor,
  ): Promise<RegisterPurchasePaymentResult> {
    return this.registerPurchasePaymentAction.execute(purchaseId, dto, companyId, actor);
  }

  listPayments(purchaseId: number, companyId: number): Promise<PurchasePayment[]> {
    return this.listPurchasePaymentsAction.execute(purchaseId, companyId);
  }
}
