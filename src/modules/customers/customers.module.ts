import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CreateCustomerAction } from './actions/create-customer.action';
import { FindAllCustomersAction } from './actions/find-all-customers.action';
import { FindCustomerAction } from './actions/find-customer.action';
import { GetCustomerChartsAction } from './actions/get-customer-charts.action';
import { GetCustomerSalesHistoryAction } from './actions/get-customer-sales-history.action';
import { ToggleCustomerArchiveAction } from './actions/toggle-customer-archive.action';
import { UpdateCustomerAction } from './actions/update-customer.action';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { Customer } from './entities/customer.entity';

/**
 * Módulo `customers`. Cablea las 7 actions del dominio + el service facade.
 *
 *   - `TypeOrmModule.forFeature([Customer])` registra el repositorio.
 *   - Se exporta el service y `TypeOrmModule` para que módulos futuros
 *     (ventas, dashboard, reports) puedan leer customers sin reabrir la
 *     registración.
 *
 * Patrón idéntico al `EmployeesModule` para mantener consistencia
 * arquitectónica.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Customer])],
  controllers: [CustomersController],
  providers: [
    CustomersService,
    FindAllCustomersAction,
    FindCustomerAction,
    CreateCustomerAction,
    UpdateCustomerAction,
    ToggleCustomerArchiveAction,
    GetCustomerSalesHistoryAction,
    GetCustomerChartsAction,
  ],
  exports: [CustomersService, TypeOrmModule],
})
export class CustomersModule {}
