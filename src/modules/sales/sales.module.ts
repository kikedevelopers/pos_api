import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { BanksModule } from '@/modules/banks/banks.module';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { CustomersModule } from '@/modules/customers/customers.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';
import { TicketSettingsModule } from '@/modules/ticket-settings/ticket-settings.module';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { ConvertOrderToSaleAction } from './actions/convert-order-to-sale.action';
import { CreateSaleAction } from './actions/create-sale.action';
import { FindAllSalesAction } from './actions/find-all-sales.action';
import { FindSaleAction } from './actions/find-sale.action';
import { FindSalesByCustomerAction } from './actions/find-sales-by-customer.action';
import { ListSalePaymentsAction } from './actions/list-sale-payments.action';
import { RegisterSalePaymentAction } from './actions/register-sale-payment.action';
import { SoftDeleteSaleAction } from './actions/soft-delete-sale.action';
import { UpdateSaleAction } from './actions/update-sale.action';
import { SaleCredit } from './entities/sale-credit.entity';
import { SaleInvoiceLine } from './entities/sale-invoice-line.entity';
import { SaleInvoice } from './entities/sale-invoice.entity';
import { SalePayment } from './entities/sale-payment.entity';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

/**
 * Módulo `sales` (Fase 6).
 *
 * Dependencias:
 *   - `TicketSettingsModule`: para generar folios atómicos (ORDER y SALE).
 *   - `BanksModule` / `WalletsModule`: para acreditar las cuentas receptoras.
 *   - `CashRegisterModule`: para insertar logs `IN, CASH_IN` cuando el cobro
 *     entra por caja.
 *   - `FinancialMovementsModule`: para registrar el INCOME (concept SALE).
 *   - `CustomersModule`: para validar y mutar `Customer.balance` (signed).
 *
 * `TypeOrmModule.forFeature` añade los repos de las 4 entidades + los repos
 * "externos" (Customer, Product, ProductPrice, Packaging, Bank, Wallet)
 * que las actions consultan directamente.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SaleInvoice,
      SaleInvoiceLine,
      SalePayment,
      SaleCredit,
      Customer,
      Product,
      ProductPrice,
      Packaging,
      Bank,
      Wallet,
    ]),
    TicketSettingsModule,
    BanksModule,
    WalletsModule,
    CashRegisterModule,
    FinancialMovementsModule,
    CustomersModule,
  ],
  controllers: [SalesController],
  providers: [
    SalesService,
    FindAllSalesAction,
    FindSaleAction,
    FindSalesByCustomerAction,
    CreateSaleAction,
    UpdateSaleAction,
    ConvertOrderToSaleAction,
    SoftDeleteSaleAction,
    RegisterSalePaymentAction,
    ListSalePaymentsAction,
  ],
  exports: [SalesService, TypeOrmModule],
})
export class SalesModule {}
