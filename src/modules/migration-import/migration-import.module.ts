import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AlertConfigsModule } from '@/modules/alert-configs/alert-configs.module';
import { AppSettingsModule } from '@/modules/app-settings/app-settings.module';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { Carrier } from '@/modules/carriers/entities/carrier.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { Category } from '@/modules/categories/entities/category.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { CreditNote } from '@/modules/credit-notes/entities/credit-note.entity';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { Employee } from '@/modules/employees/entities/employee.entity';
import { Expense } from '@/modules/expenses/entities/expense.entity';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';
import { Purchase } from '@/modules/purchases/entities/purchase.entity';
import { PurchaseLine } from '@/modules/purchases/entities/purchase-line.entity';
import { PurchasePayment } from '@/modules/purchases/entities/purchase-payment.entity';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SalePayment } from '@/modules/sales/entities/sale-payment.entity';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';
import { TicketSettingsModule } from '@/modules/ticket-settings/ticket-settings.module';
import { User } from '@/modules/users/entities/user.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { ImportZipAction } from './actions/import-zip.action';
import { MigrationImportController } from './migration-import.controller';
import { MigrationImportService } from './migration-import.service';

/**
 * Módulo dev-only que importa ZIPs generados por el migrador placepos.
 *
 * Importa los módulos de seeds (`Wallets`, `TicketSettings`, `AppSettings`,
 * `AlertConfigs`) para reutilizar sus `CreateDefault*Action`. Registra las
 * entities con `TypeOrmModule.forFeature` para que TypeORM exponga sus
 * repositorios al `EntityManager` dentro de la transacción.
 *
 * El gate de "no producción" se aplica en `app.module.ts` — el módulo solo
 * se importa si `NODE_ENV !== 'production'`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Company,
      User,
      Employee,
      Category,
      Packaging,
      Product,
      ProductPrice,
      Customer,
      Supplier,
      Bank,
      Carrier,
      Wallet,
      CashRegister,
      SaleInvoice,
      SaleInvoiceLine,
      SalePayment,
      CreditNote,
      CreditNoteLine,
      Purchase,
      PurchaseLine,
      PurchasePayment,
      Expense,
    ]),
    // Seeds esenciales (reuso de los `CreateDefault*Action`).
    WalletsModule,
    TicketSettingsModule,
    AppSettingsModule,
    AlertConfigsModule,
  ],
  controllers: [MigrationImportController],
  providers: [ImportZipAction, MigrationImportService],
})
export class MigrationImportModule {}
