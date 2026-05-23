import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { BanksModule } from '@/modules/banks/banks.module';
import { CarrierPayment } from '@/modules/carrier-payments/entities/carrier-payment.entity';
import { CarrierCredit } from '@/modules/carriers/entities/carrier-credit.entity';
import { Carrier } from '@/modules/carriers/entities/carrier.entity';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';
import { SuppliersModule } from '@/modules/suppliers/suppliers.module';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { ArchivePurchaseAction } from './actions/archive-purchase.action';
import { CreatePurchaseAction } from './actions/create-purchase.action';
import { FindAllPurchasesAction } from './actions/find-all-purchases.action';
import { FindPurchaseAction } from './actions/find-purchase.action';
import { FindPurchasesBySupplierAction } from './actions/find-purchases-by-supplier.action';
import { MarkPurchaseReceivedAction } from './actions/mark-purchase-received.action';
import { ProcessBulkPurchasePaymentsAction } from './actions/process-bulk-purchase-payments.action';
import { RegisterPurchasePaymentAction } from './actions/register-purchase-payment.action';
import { UpdatePurchaseAction } from './actions/update-purchase.action';
import { PurchaseCredit } from './entities/purchase-credit.entity';
import { PurchaseLine } from './entities/purchase-line.entity';
import { PurchasePayment } from './entities/purchase-payment.entity';
import { Purchase } from './entities/purchase.entity';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';

/**
 * Módulo `purchases` (Fase 8).
 *
 * Dependencias:
 *   - `BanksModule` / `WalletsModule`: para debitar las fuentes de pago.
 *   - `CashRegisterModule`: para validar saldo de turno y emitir log de OUT
 *     cuando el pago sale por caja.
 *   - `FinancialMovementsModule`: para registrar el EXPENSE asociado al pago.
 *   - `SuppliersModule`: para incrementar/decrementar `accumulated_debt`.
 *
 * `TypeOrmModule.forFeature` añade los repos de las 4 entidades + los repos
 * "externos" (Supplier, Product, Packaging, Bank, Wallet) que las actions
 * consultan directamente.
 *
 * Se exporta `PurchasesService` + TypeOrmModule para que futuros módulos
 * (`dashboard`, `reports`, `pos-reports`) consuman datos de compras sin
 * reabrir las dependencias.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Purchase,
      PurchaseLine,
      PurchasePayment,
      PurchaseCredit,
      Supplier,
      Product,
      Packaging,
      Bank,
      Wallet,
      Carrier,
      CarrierCredit,
      CarrierPayment,
    ]),
    BanksModule,
    WalletsModule,
    CashRegisterModule,
    FinancialMovementsModule,
    SuppliersModule,
  ],
  controllers: [PurchasesController],
  providers: [
    PurchasesService,
    FindAllPurchasesAction,
    FindPurchaseAction,
    FindPurchasesBySupplierAction,
    CreatePurchaseAction,
    UpdatePurchaseAction,
    MarkPurchaseReceivedAction,
    ArchivePurchaseAction,
    RegisterPurchasePaymentAction,
    ProcessBulkPurchasePaymentsAction,
  ],
  exports: [PurchasesService, TypeOrmModule],
})
export class PurchasesModule {}
