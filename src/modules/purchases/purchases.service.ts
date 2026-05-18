import { Injectable } from '@nestjs/common';

import { ArchivePurchaseAction } from './actions/archive-purchase.action';
import { CreatePurchaseAction, type PurchaseCreator } from './actions/create-purchase.action';
import { FindAllPurchasesAction, type PurchaseListItem } from './actions/find-all-purchases.action';
import { FindPurchaseAction, type PurchaseAggregate } from './actions/find-purchase.action';
import { FindPurchasesBySupplierAction } from './actions/find-purchases-by-supplier.action';
import { MarkPurchaseReceivedAction } from './actions/mark-purchase-received.action';
import {
  ProcessBulkPurchasePaymentsAction,
  type ProcessBulkPurchasePaymentsResult,
} from './actions/process-bulk-purchase-payments.action';
import {
  RegisterPurchasePaymentAction,
  type PurchasePaymentActor,
  type RegisterPurchasePaymentResult,
} from './actions/register-purchase-payment.action';
import { UpdatePurchaseAction, type UpdatePurchaseActor } from './actions/update-purchase.action';
import type { BulkPurchasePaymentsDto } from './dto/bulk-purchase-payments.dto';
import type { CreatePurchasePaymentDto } from './dto/create-purchase-payment.dto';
import type { CreatePurchaseDto } from './dto/create-purchase.dto';
import type { ReceivePurchaseDto } from './dto/receive-purchase.dto';
import type { UpdatePurchaseDto } from './dto/update-purchase.dto';
import type { Purchase } from './entities/purchase.entity';

export type { PurchaseCreator } from './actions/create-purchase.action';
export type {
  PurchasePaymentActor,
  RegisterPurchasePaymentResult,
} from './actions/register-purchase-payment.action';
export type { UpdatePurchaseActor } from './actions/update-purchase.action';
export type {
  BulkAppliedPurchasePayment,
  ProcessBulkPurchasePaymentsResult,
} from './actions/process-bulk-purchase-payments.action';
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
    private readonly updatePurchaseAction: UpdatePurchaseAction,
    private readonly markPurchaseReceivedAction: MarkPurchaseReceivedAction,
    private readonly archivePurchaseAction: ArchivePurchaseAction,
    private readonly registerPurchasePaymentAction: RegisterPurchasePaymentAction,
    private readonly processBulkPurchasePaymentsAction: ProcessBulkPurchasePaymentsAction,
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

  update(
    id: number,
    dto: UpdatePurchaseDto,
    companyId: number,
    actor: UpdatePurchaseActor,
  ): Promise<PurchaseAggregate> {
    return this.updatePurchaseAction.execute(id, dto, companyId, actor);
  }

  markReceived(
    id: number,
    dto: ReceivePurchaseDto,
    companyId: number,
    actorId: number,
  ): Promise<PurchaseAggregate> {
    return this.markPurchaseReceivedAction.execute(id, dto, companyId, actorId);
  }

  archive(id: number, companyId: number, actorId: number): Promise<void> {
    return this.archivePurchaseAction.execute(id, companyId, actorId);
  }

  registerPayment(
    purchaseId: number,
    dto: CreatePurchasePaymentDto,
    companyId: number,
    actor: PurchasePaymentActor,
  ): Promise<RegisterPurchasePaymentResult> {
    return this.registerPurchasePaymentAction.execute(purchaseId, dto, companyId, actor);
  }

  processBulkPayments(
    dto: BulkPurchasePaymentsDto,
    companyId: number,
    actor: PurchasePaymentActor,
  ): Promise<ProcessBulkPurchasePaymentsResult> {
    return this.processBulkPurchasePaymentsAction.execute(dto, companyId, actor);
  }
}
