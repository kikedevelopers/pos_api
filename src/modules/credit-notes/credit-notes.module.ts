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
import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { SalePayment } from '@/modules/sales/entities/sale-payment.entity';
import { SalesModule } from '@/modules/sales/sales.module';
import { TicketSettingsModule } from '@/modules/ticket-settings/ticket-settings.module';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { CreateCreditNoteAction } from './actions/create-credit-note.action';
import { FindAllCreditNotesAction } from './actions/find-all-credit-notes.action';
import { FindCreditNoteAction } from './actions/find-credit-note.action';
import { FindCreditNotesBySaleAction } from './actions/find-credit-notes-by-sale.action';
import { SoftDeleteCreditNoteAction } from './actions/soft-delete-credit-note.action';
import { CreditNotesController } from './credit-notes.controller';
import { CreditNotesService } from './credit-notes.service';
import { CorrectionSource } from './entities/correction-source.entity';
import { CreditNoteLine } from './entities/credit-note-line.entity';
import { CreditNote } from './entities/credit-note.entity';

/**
 * Módulo `credit-notes` (Fase 7).
 *
 * Dependencias:
 *   - `TicketSettingsModule`: para generar folios atómicos (CREDIT_NOTE /
 *     DEBIT_NOTE).
 *   - `SalesModule`: para acceder a `SaleInvoice`, `SalePayment`,
 *     `SaleCredit`, `SaleInvoiceLine` y los lookups internos.
 *   - `BanksModule` / `WalletsModule`: para reversar balances (FULL_VOID).
 *   - `CashRegisterModule`: para insertar logs `OUT, CASH_OUT` cuando se
 *     reversa un pago en efectivo.
 *   - `FinancialMovementsModule`: para registrar EXPENSE (concept
 *     CREDIT_NOTE_REFUND).
 *   - `CustomersModule`: para mutar `Customer.balance` (signed).
 *
 * `TypeOrmModule.forFeature` añade los repos de las 3 entidades propias +
 * los repos "externos" (Product, Packaging, Customer, Bank, Wallet,
 * SaleInvoice, SaleInvoiceLine, SalePayment) que las actions consultan
 * directamente.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CreditNote,
      CreditNoteLine,
      CorrectionSource,
      Product,
      Packaging,
      Customer,
      Bank,
      Wallet,
      SaleInvoice,
      SaleInvoiceLine,
      SalePayment,
    ]),
    TicketSettingsModule,
    SalesModule,
    BanksModule,
    WalletsModule,
    CashRegisterModule,
    FinancialMovementsModule,
    CustomersModule,
  ],
  controllers: [CreditNotesController],
  providers: [
    CreditNotesService,
    FindAllCreditNotesAction,
    FindCreditNoteAction,
    FindCreditNotesBySaleAction,
    CreateCreditNoteAction,
    SoftDeleteCreditNoteAction,
  ],
  exports: [CreditNotesService, TypeOrmModule],
})
export class CreditNotesModule {}
