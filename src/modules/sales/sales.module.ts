import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { BanksModule } from '@/modules/banks/banks.module';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { CreditNote } from '@/modules/credit-notes/entities/credit-note.entity';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { CustomersModule } from '@/modules/customers/customers.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';
import { RealtimeModule } from '@/modules/realtime/realtime.module';
import { TicketSettingsModule } from '@/modules/ticket-settings/ticket-settings.module';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { CollectSaleBalanceAction } from './actions/collect-sale-balance.action';
import { CreateSaleAction } from './actions/create-sale.action';
import { DeleteSalePaymentAction } from './actions/delete-sale-payment.action';
import { FindAllSalesAction } from './actions/find-all-sales.action';
import { FindSaleAction } from './actions/find-sale.action';
import { GetConsolidatedInvoiceAction } from './actions/get-consolidated-invoice.action';
import { GetConsolidatedInvoiceUpToAction } from './actions/get-consolidated-invoice-upto.action';
import { GetLastSaleAction } from './actions/get-last-sale.action';
import { GetSaleCreditNoteAction } from './actions/get-sale-credit-note.action';
import { UpdateSaleAction } from './actions/update-sale.action';
import { UpdateSaleNoteAction } from './actions/update-sale-note.action';
import { VoidSaleAction } from './actions/void-sale.action';
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
      CreditNote,
      CreditNoteLine,
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
    // Tiempo real: expone `RealtimeGateway` para notificar `ticket:changed`
    // tras crear una venta (best-effort, no altera la respuesta HTTP).
    RealtimeModule,
  ],
  controllers: [SalesController],
  providers: [
    SalesService,
    FindAllSalesAction,
    FindSaleAction,
    CreateSaleAction,
    UpdateSaleAction,
    UpdateSaleNoteAction,
    VoidSaleAction,
    DeleteSalePaymentAction,
    CollectSaleBalanceAction,
    GetLastSaleAction,
    GetConsolidatedInvoiceAction,
    GetConsolidatedInvoiceUpToAction,
    GetSaleCreditNoteAction,
  ],
  exports: [SalesService, TypeOrmModule],
})
export class SalesModule {}
