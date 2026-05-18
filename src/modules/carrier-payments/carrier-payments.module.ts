import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BanksModule } from '@/modules/banks/banks.module';
import { CarriersModule } from '@/modules/carriers/carriers.module';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { PurchasesModule } from '@/modules/purchases/purchases.module';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { ListCarrierPaymentsAction } from './actions/list-carrier-payments.action';
import { ProcessCarrierPaymentAction } from './actions/process-carrier-payment.action';
import { CarrierPaymentsController } from './carrier-payments.controller';
import { CarrierPaymentsService } from './carrier-payments.service';
import { CarrierPayment } from './entities/carrier-payment.entity';

/**
 * Módulo `carrier-payments` — Fase 2A.
 *
 * Depende de:
 *   - `CarriersModule` para `Carrier` / `CarrierCredit` (lock + update).
 *   - `BanksModule`, `WalletsModule` para débitos por fuente.
 *   - `CashRegisterModule` para registrar las entidades `CashRegister` /
 *     `CashRegisterLog` y reusar el helper `getOrCreateCashRegisterForUser`.
 *   - `FinancialMovementsModule` para `FinancialMovementsService.record(...)`.
 *   - `PurchasesModule` para resolver `purchase_number` del credit.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CarrierPayment]),
    CarriersModule,
    BanksModule,
    WalletsModule,
    CashRegisterModule,
    FinancialMovementsModule,
    PurchasesModule,
  ],
  controllers: [CarrierPaymentsController],
  providers: [CarrierPaymentsService, ProcessCarrierPaymentAction, ListCarrierPaymentsAction],
  exports: [CarrierPaymentsService],
})
export class CarrierPaymentsModule {}
