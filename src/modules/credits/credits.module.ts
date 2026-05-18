import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { CashRegisterLog } from '@/modules/cash-register/entities/cash-register-log.entity';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { SaleCredit } from '@/modules/sales/entities/sale-credit.entity';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { SalePayment } from '@/modules/sales/entities/sale-payment.entity';

import { ProcessCreditPaymentAction } from './actions/process-credit-payment.action';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';

/**
 * Módulo `credits` (Fase 9).
 *
 * Expone `POST /credits` — espejo PlacePos `processCreditPayment`:
 *   abono (CASH | TRANSFER) a un `SaleCredit` pendiente.
 *
 * Dependencias:
 *   - `FinancialMovementsModule`: registra `INCOME` con concept
 *     `SALE_PAYMENT` cuando el abono entra por banco (paridad PlacePos).
 *   - `TypeOrmModule.forFeature`: repos directamente leídos/escritos por la
 *     action (`SaleCredit`, `SalePayment`, `SaleInvoice`, `Bank`,
 *     `CashRegister`, `CashRegisterLog`).
 *
 * Nota: NO importamos `SalesModule`, `BanksModule` ni `CashRegisterModule`
 * para evitar ciclos de dependencia — la action consume las entidades
 * directamente con `EntityManager` dentro de la transacción, no servicios.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SaleCredit,
      SalePayment,
      SaleInvoice,
      Bank,
      CashRegister,
      CashRegisterLog,
    ]),
    FinancialMovementsModule,
  ],
  controllers: [CreditsController],
  providers: [CreditsService, ProcessCreditPaymentAction],
  exports: [CreditsService],
})
export class CreditsModule {}
