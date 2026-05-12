import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { BanksModule } from '@/modules/banks/banks.module';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';
import { SuppliersModule } from '@/modules/suppliers/suppliers.module';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { CreatePurchaseAction } from './actions/create-purchase.action';
import { FindAllPurchasesAction } from './actions/find-all-purchases.action';
import { FindPurchaseAction } from './actions/find-purchase.action';
import { FindPurchasesBySupplierAction } from './actions/find-purchases-by-supplier.action';
import { ListPurchasePaymentsAction } from './actions/list-purchase-payments.action';
import { MarkPurchaseReceivedAction } from './actions/mark-purchase-received.action';
import { RegisterPurchasePaymentAction } from './actions/register-purchase-payment.action';
import { SoftDeletePurchaseAction } from './actions/soft-delete-purchase.action';
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
    MarkPurchaseReceivedAction,
    SoftDeletePurchaseAction,
    RegisterPurchasePaymentAction,
    ListPurchasePaymentsAction,
  ],
  exports: [PurchasesService, TypeOrmModule],
})
export class PurchasesModule {}
