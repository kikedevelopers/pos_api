import { Injectable } from '@nestjs/common';

import { CreateCustomerAction, type CustomerCreator } from './actions/create-customer.action';
import { FindAllCustomersAction } from './actions/find-all-customers.action';
import { FindCustomerAction } from './actions/find-customer.action';
import {
  GetCustomerChartsAction,
  type CustomerProductHistoryResponse,
  type CustomerSalesChartResponse,
} from './actions/get-customer-charts.action';
import {
  GetCustomerSalesHistoryAction,
  type CustomerSalesHistoryResponse,
} from './actions/get-customer-sales-history.action';
import { ToggleCustomerArchiveAction } from './actions/toggle-customer-archive.action';
import { UpdateCustomerAction } from './actions/update-customer.action';
import type { CreateCustomerDto } from './dto/create-customer.dto';
import type { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import type { UpdateCustomerDto } from './dto/update-customer.dto';
import type { Customer } from './entities/customer.entity';

export type { CustomerCreator } from './actions/create-customer.action';

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
    private readonly toggleCustomerArchiveAction: ToggleCustomerArchiveAction,
    private readonly getCustomerSalesHistoryAction: GetCustomerSalesHistoryAction,
    private readonly getCustomerChartsAction: GetCustomerChartsAction,
  ) {}

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

  toggleArchive(id: number, companyId: number, actorId: number): Promise<Customer> {
    return this.toggleCustomerArchiveAction.execute(id, companyId, actorId);
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
