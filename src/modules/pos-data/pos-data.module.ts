import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { Product } from '@/modules/products/entities/product.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import { GetCustomersAction } from './actions/get-customers.action';
import { GetItemsAction } from './actions/get-items.action';
import { GetPaymentBanksAction } from './actions/get-payment-banks.action';
import { GetPosTransferDestinationsAction } from './actions/get-transfer-destinations.action';
import { TransferCashAction } from './actions/transfer-cash.action';
import { PosDataController } from './pos-data.controller';
import { PosDataService } from './pos-data.service';

/**
 * Módulo `pos-data` (Fase 11.4). Endpoints operativos del POS: listados
 * planos (items/customers/payment-banks) + transfer-cash desde caja
 * abierta. Importa `FinancialMovementsModule` para registrar movimientos y
 * `CashRegisterModule` para reutilizar la entidad del turno abierto (los
 * helpers de internal/cash-register-lookups no requieren provider explícito).
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
  ],
  exports: [PosDataService],
})
export class PosDataModule {}
