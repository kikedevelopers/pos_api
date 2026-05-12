import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { BanksModule } from '@/modules/banks/banks.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
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
 * TypeOrmModule de Bank y Wallet), `FinancialMovementsModule` para el
 * service que registra los dos movements del par de transferencia, y
 * registra Bank/Wallet con `forFeature` para que la action de destinos
 * tenga sus repos inyectados directamente.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Bank, Wallet]),
    BanksModule,
    WalletsModule,
    FinancialMovementsModule,
  ],
  controllers: [AccountsController],
  providers: [AccountsService, GetTransferDestinationsAction, TransferAction],
  exports: [AccountsService],
})
export class AccountsModule {}
