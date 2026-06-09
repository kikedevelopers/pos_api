import { Injectable } from '@nestjs/common';

import { ArchiveCustomerAction } from './actions/archive-customer.action';
import {
  CreateCustomerAdvanceAction,
  type CreateCustomerAdvanceResult,
  type CustomerAdvanceActor,
} from './actions/create-customer-advance.action';
import { CreateCustomerAction, type CustomerCreator } from './actions/create-customer.action';
import { FindAllCustomersAction } from './actions/find-all-customers.action';
import { FindCustomerAction } from './actions/find-customer.action';
import { ListCustomerAdvancesAction } from './actions/list-customer-advances.action';
import {
  GetCustomerChartsAction,
  type CustomerProductHistoryResponse,
  type CustomerSalesChartResponse,
} from './actions/get-customer-charts.action';
import {
  GetCustomerSalesHistoryAction,
  type CustomerSalesHistoryResponse,
} from './actions/get-customer-sales-history.action';
import {
  GetCustomersAnalyticsAction,
  type CustomersAnalyticsResponse,
} from './actions/get-customers-analytics.action';
import { UpdateCustomerAction } from './actions/update-customer.action';
import type { CreateCustomerAdvanceDto } from './dto/create-customer-advance.dto';
import type { CreateCustomerDto } from './dto/create-customer.dto';
import type { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import type { UpdateCustomerDto } from './dto/update-customer.dto';
import type { CustomerAdvance } from './entities/customer-advance.entity';
import type { Customer } from './entities/customer.entity';

export type { CustomerCreator } from './actions/create-customer.action';
export type {
  CreateCustomerAdvanceResult,
  CustomerAdvanceActor,
} from './actions/create-customer-advance.action';
export type { CustomersAnalyticsResponse } from './actions/get-customers-analytics.action';

/**
 * Facade delgado del dominio `customers`. Sin lógica de negocio — solo
 * delega a la action correspondiente (CLAUDE.md §3.1).
 *
 * Razón: el controller inyecta UN service (firma estable). Tests unitarios
 * apuntan a actions; e2e cubre el service por debajo.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly findAllCustomersAction: FindAllCustomersAction,
    private readonly findCustomerAction: FindCustomerAction,
    private readonly createCustomerAction: CreateCustomerAction,
    private readonly updateCustomerAction: UpdateCustomerAction,
    private readonly getCustomerSalesHistoryAction: GetCustomerSalesHistoryAction,
    private readonly getCustomerChartsAction: GetCustomerChartsAction,
    private readonly getCustomersAnalyticsAction: GetCustomersAnalyticsAction,
    private readonly archiveCustomerAction: ArchiveCustomerAction,
    private readonly createCustomerAdvanceAction: CreateCustomerAdvanceAction,
    private readonly listCustomerAdvancesAction: ListCustomerAdvancesAction,
  ) {}

  getAnalytics(companyId: number): Promise<CustomersAnalyticsResponse> {
    return this.getCustomersAnalyticsAction.execute(companyId);
  }

  findAll(companyId: number, query: ListCustomersQueryDto = {}): Promise<Customer[]> {
    return this.findAllCustomersAction.execute(companyId, query);
  }

  findOne(id: number, companyId: number): Promise<Customer> {
    return this.findCustomerAction.execute(id, companyId);
  }

  create(dto: CreateCustomerDto, companyId: number, createdBy: CustomerCreator): Promise<Customer> {
    return this.createCustomerAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdateCustomerDto, companyId: number): Promise<Customer> {
    return this.updateCustomerAction.execute(id, dto, companyId);
  }

  archive(id: number, isArchived: boolean, companyId: number): Promise<Customer> {
    return this.archiveCustomerAction.execute(id, isArchived, companyId);
  }

  createAdvance(
    id: number,
    dto: CreateCustomerAdvanceDto,
    companyId: number,
    actor: CustomerAdvanceActor,
  ): Promise<CreateCustomerAdvanceResult> {
    return this.createCustomerAdvanceAction.execute(id, dto, companyId, actor);
  }

  listAdvances(id: number, companyId: number): Promise<CustomerAdvance[]> {
    return this.listCustomerAdvancesAction.execute(id, companyId);
  }

  getSalesHistory(id: number, companyId: number): Promise<CustomerSalesHistoryResponse> {
    return this.getCustomerSalesHistoryAction.execute(id, companyId);
  }

  getSalesChart(
    id: number,
    companyId: number,
    startDate?: string,
    endDate?: string,
  ): Promise<CustomerSalesChartResponse> {
    return this.getCustomerChartsAction.getSalesChart(id, companyId, startDate, endDate);
  }

  getProductHistory(id: number, companyId: number): Promise<CustomerProductHistoryResponse> {
    return this.getCustomerChartsAction.getProductHistory(id, companyId);
  }
}
