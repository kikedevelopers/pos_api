import { Injectable } from '@nestjs/common';

import {
  ArchivePurchaseAction,
  type ArchivePurchaseActor,
} from './actions/archive-purchase.action';
import { CreatePurchaseAction, type PurchaseCreator } from './actions/create-purchase.action';
import { FindAllPurchasesAction, type PurchaseListItem } from './actions/find-all-purchases.action';
import {
  FindLastPurchaseCostsAction,
  type LastPurchaseCost,
} from './actions/find-last-purchase-costs.action';
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
import { UpdatePurchasePaymentDueAction } from './actions/update-purchase-payment-due.action';
import { UpdatePurchaseAction, type UpdatePurchaseActor } from './actions/update-purchase.action';
import type { ArchivePurchaseDto } from './dto/archive-purchase.dto';
import type { BulkPurchasePaymentsDto } from './dto/bulk-purchase-payments.dto';
import type { CreatePurchasePaymentDto } from './dto/create-purchase-payment.dto';
import type { CreatePurchaseDto } from './dto/create-purchase.dto';
import type { ReceivePurchaseDto } from './dto/receive-purchase.dto';
import type { UpdatePurchasePaymentDueDto } from './dto/update-purchase-payment-due.dto';
import type { UpdatePurchaseDto } from './dto/update-purchase.dto';
import type { Purchase } from './entities/purchase.entity';

export type { ArchivePurchaseActor } from './actions/archive-purchase.action';
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
    private readonly findLastPurchaseCostsAction: FindLastPurchaseCostsAction,
    private readonly createPurchaseAction: CreatePurchaseAction,
    private readonly updatePurchaseAction: UpdatePurchaseAction,
    private readonly markPurchaseReceivedAction: MarkPurchaseReceivedAction,
    private readonly archivePurchaseAction: ArchivePurchaseAction,
    private readonly registerPurchasePaymentAction: RegisterPurchasePaymentAction,
    private readonly processBulkPurchasePaymentsAction: ProcessBulkPurchasePaymentsAction,
    private readonly updatePurchasePaymentDueAction: UpdatePurchasePaymentDueAction,
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

  findLastCosts(companyId: number): Promise<LastPurchaseCost[]> {
    return this.findLastPurchaseCostsAction.execute(companyId);
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

  updatePaymentDue(
    id: number,
    dto: UpdatePurchasePaymentDueDto,
    companyId: number,
  ): Promise<PurchaseAggregate> {
    return this.updatePurchasePaymentDueAction.execute(id, dto, companyId);
  }

  markReceived(
    id: number,
    dto: ReceivePurchaseDto,
    companyId: number,
    actorId: number,
  ): Promise<PurchaseAggregate> {
    return this.markPurchaseReceivedAction.execute(id, dto, companyId, actorId);
  }

  archive(
    id: number,
    dto: ArchivePurchaseDto,
    companyId: number,
    actor: ArchivePurchaseActor,
  ): Promise<void> {
    return this.archivePurchaseAction.execute(id, dto, companyId, actor);
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
