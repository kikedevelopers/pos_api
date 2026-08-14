import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppSettingsModule } from '@/modules/app-settings/app-settings.module';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';

import { ArchiveCustomerAction } from './actions/archive-customer.action';
import { CreateCustomerAdvanceAction } from './actions/create-customer-advance.action';
import { CreateCustomerAction } from './actions/create-customer.action';
import { FindAllCustomersAction } from './actions/find-all-customers.action';
import { FindCustomerAction } from './actions/find-customer.action';
import { GetCustomerChartsAction } from './actions/get-customer-charts.action';
import { GetCustomerSalesHistoryAction } from './actions/get-customer-sales-history.action';
import { GetCustomersAnalyticsAction } from './actions/get-customers-analytics.action';
import { ListCustomerAdvancesAction } from './actions/list-customer-advances.action';
import { UpdateCustomerAction } from './actions/update-customer.action';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CustomerAdvance } from './entities/customer-advance.entity';
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
  imports: [
    TypeOrmModule.forFeature([Customer, CustomerAdvance]),
    // Para registrar el ingreso de dinero del anticipo dentro de la
    // transacción de `CreateCustomerAdvanceAction`.
    CashRegisterModule,
    FinancialMovementsModule,
    // Flag `include_orders_in_reports`: la gráfica del cliente cuenta los
    // pedidos con el MISMO criterio que el informe de ventas.
    AppSettingsModule,
  ],
  controllers: [CustomersController],
  providers: [
    CustomersService,
    FindAllCustomersAction,
    FindCustomerAction,
    CreateCustomerAction,
    UpdateCustomerAction,
    GetCustomerSalesHistoryAction,
    GetCustomerChartsAction,
    GetCustomersAnalyticsAction,
    ArchiveCustomerAction,
    CreateCustomerAdvanceAction,
    ListCustomerAdvancesAction,
  ],
  exports: [CustomersService, TypeOrmModule],
})
export class CustomersModule {}
