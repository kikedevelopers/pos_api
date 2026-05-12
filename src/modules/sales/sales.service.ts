import { Injectable } from '@nestjs/common';

import { ConvertOrderToSaleAction } from './actions/convert-order-to-sale.action';
import { CreateSaleAction, type SaleCreator } from './actions/create-sale.action';
import { FindAllSalesAction } from './actions/find-all-sales.action';
import { FindSaleAction, type SaleAggregate } from './actions/find-sale.action';
import { FindSalesByCustomerAction } from './actions/find-sales-by-customer.action';
import { ListSalePaymentsAction } from './actions/list-sale-payments.action';
import {
  RegisterSalePaymentAction,
  type RegisterSalePaymentResult,
} from './actions/register-sale-payment.action';
import { SoftDeleteSaleAction } from './actions/soft-delete-sale.action';
import { UpdateSaleAction } from './actions/update-sale.action';
import type { CreateSalePaymentDto } from './dto/create-sale-payment.dto';
import type { CreateSaleDto } from './dto/create-sale.dto';
import type { ListSalesQueryDto } from './dto/list-sales-query.dto';
import type { UpdateSaleDto } from './dto/update-sale.dto';
import type { SaleInvoice } from './entities/sale-invoice.entity';
import type { SalePayment } from './entities/sale-payment.entity';
import type { SalePaymentActor } from './internal/apply-sale-payment';

export type { SaleCreator } from './actions/create-sale.action';
export type { SaleAggregate } from './actions/find-sale.action';
export type { RegisterSalePaymentResult } from './actions/register-sale-payment.action';
export type { SalePaymentActor } from './internal/apply-sale-payment';

/**
 * Facade del módulo `sales`. ZERO lógica — solo delega.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly findAllSalesAction: FindAllSalesAction,
    private readonly findSaleAction: FindSaleAction,
    private readonly findSalesByCustomerAction: FindSalesByCustomerAction,
    private readonly createSaleAction: CreateSaleAction,
    private readonly updateSaleAction: UpdateSaleAction,
    private readonly convertOrderToSaleAction: ConvertOrderToSaleAction,
    private readonly softDeleteSaleAction: SoftDeleteSaleAction,
    private readonly registerSalePaymentAction: RegisterSalePaymentAction,
    private readonly listSalePaymentsAction: ListSalePaymentsAction,
  ) {}

  findAll(companyId: number, query: ListSalesQueryDto): Promise<SaleInvoice[]> {
    return this.findAllSalesAction.execute(companyId, query);
  }

  findOne(id: number, companyId: number): Promise<SaleAggregate> {
    return this.findSaleAction.execute(id, companyId);
  }

  findByCustomer(customerId: number, companyId: number): Promise<SaleInvoice[]> {
    return this.findSalesByCustomerAction.execute(customerId, companyId);
  }

  create(dto: CreateSaleDto, companyId: number, createdBy: SaleCreator): Promise<SaleAggregate> {
    return this.createSaleAction.execute(dto, companyId, createdBy);
  }

  update(
    id: number,
    dto: UpdateSaleDto,
    companyId: number,
    actorId: number,
  ): Promise<SaleAggregate> {
    return this.updateSaleAction.execute(id, dto, companyId, actorId);
  }

  convert(id: number, companyId: number, actorId: number): Promise<SaleAggregate> {
    return this.convertOrderToSaleAction.execute(id, companyId, actorId);
  }

  softDelete(id: number, companyId: number, actorId: number): Promise<void> {
    return this.softDeleteSaleAction.execute(id, companyId, actorId);
  }

  registerPayment(
    saleId: number,
    dto: CreateSalePaymentDto,
    companyId: number,
    actor: SalePaymentActor,
  ): Promise<RegisterSalePaymentResult> {
    return this.registerSalePaymentAction.execute(saleId, dto, companyId, actor);
  }

  listPayments(saleId: number, companyId: number): Promise<SalePayment[]> {
    return this.listSalePaymentsAction.execute(saleId, companyId);
  }
}
