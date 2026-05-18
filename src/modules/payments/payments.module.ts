import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { BanksModule } from '@/modules/banks/banks.module';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { CashRegisterLog } from '@/modules/cash-register/entities/cash-register-log.entity';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { ProductsModule } from '@/modules/products/products.module';
import { SaleCredit } from '@/modules/sales/entities/sale-credit.entity';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SalePayment } from '@/modules/sales/entities/sale-payment.entity';
import { TicketSettingsModule } from '@/modules/ticket-settings/ticket-settings.module';

import { ProcessPaymentAction } from './actions/process-payment.action';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Módulo `payments` (Fase 4).
 *
 * Expone `POST /payments` — espejo de PlacePos `processPayment`. La action
 * orquesta:
 *
 *   - Folios SALE (TicketSettingsModule).
 *   - Acreditación de Bank / CashRegister + logs auditables (BanksModule,
 *     CashRegisterModule).
 *   - Registro de FinancialMovement INCOME / SALE (FinancialMovementsModule).
 *   - Ajuste de inventario `DEDUCT` (ProductsModule — helper stub hoy).
 *
 * `TypeOrmModule.forFeature` añade los repositorios "leaf" que la action
 * consulta o inserta directamente sin pasar por otro service.
 *
 * NOTA: este módulo NO importa `SalesModule` para evitar dependencia
 * circular (`SalesModule` podría a futuro importar `PaymentsModule` para
 * delegar el cierre de pedidos). En su lugar `TypeOrmModule.forFeature`
 * registra explícitamente las entidades de ventas que la action toca.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SaleInvoice,
      SaleInvoiceLine,
      SalePayment,
      SaleCredit,
      Bank,
      CashRegister,
      CashRegisterLog,
    ]),
    TicketSettingsModule,
    BanksModule,
    CashRegisterModule,
    FinancialMovementsModule,
    ProductsModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, ProcessPaymentAction],
  exports: [PaymentsService],
})
export class PaymentsModule {}
