import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { Product } from '@/modules/products/entities/product.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import { CloseCashAction } from './actions/close-cash.action';
import { GetCashSummaryAction } from './actions/get-cash-summary.action';
import { GetCustomersAction } from './actions/get-customers.action';
import { GetItemsAction } from './actions/get-items.action';
import { GetPaymentBanksAction } from './actions/get-payment-banks.action';
import { GetPosTransferDestinationsAction } from './actions/get-transfer-destinations.action';
import { TransferCashAction } from './actions/transfer-cash.action';
import { PosDataController } from './pos-data.controller';
import { PosDataService } from './pos-data.service';

/**
 * Módulo `pos-data` (Fase 11.4). Endpoints operativos del POS: listados
 * planos (items/customers/payment-banks) + transfer-cash desde la caja
 * PERMANENTE del actor. Importa `FinancialMovementsModule` para registrar
 * movimientos y `CashRegisterModule` para reutilizar la entidad y el
 * helper `getOrCreateCashRegisterForUser`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Product, Customer, Bank, Wallet]),
    FinancialMovementsModule,
    CashRegisterModule,
  ],
  controllers: [PosDataController],
  providers: [
    PosDataService,
    GetItemsAction,
    GetCustomersAction,
    GetPaymentBanksAction,
    GetPosTransferDestinationsAction,
    TransferCashAction,
    CloseCashAction,
    GetCashSummaryAction,
  ],
  exports: [PosDataService],
})
export class PosDataModule {}
