import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { BanksModule } from '@/modules/banks/banks.module';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { UsersModule } from '@/modules/users/users.module';
import { WalletsModule } from '@/modules/wallets/wallets.module';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { GetTransferDestinationsAction } from './actions/get-transfer-destinations.action';
import { TransferAction } from './actions/transfer.action';

/**
 * Módulo agregador `accounts`.
 *
 * Importa `BanksModule` y `WalletsModule` por simetría (reexportan
 * TypeOrmModule de Bank y Wallet), `FinancialMovementsModule` para registrar
 * los dos movements del par de transferencia, `CashRegisterModule` para
 * acreditar la caja del usuario destinatario cuando `destinationType=user`,
 * y `UsersModule` para reusar el repositorio de `User` (validación
 * multi-tenant del destinatario).
 *
 * `TypeOrmModule.forFeature([Bank, Wallet])` se mantiene para que la action
 * de destinos tenga sus repos inyectados directamente sin atravesar el
 * facade de cada módulo.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Bank, Wallet]),
    BanksModule,
    WalletsModule,
    FinancialMovementsModule,
    CashRegisterModule,
    UsersModule,
  ],
  controllers: [AccountsController],
  providers: [AccountsService, GetTransferDestinationsAction, TransferAction],
  exports: [AccountsService],
})
export class AccountsModule {}
