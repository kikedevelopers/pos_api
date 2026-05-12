import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';

import { ArchiveWalletAction } from './actions/archive-wallet.action';
import { CreateDefaultWalletAction } from './actions/create-default-wallet.action';
import { CreateWalletAction } from './actions/create-wallet.action';
import { FindAllWalletsAction } from './actions/find-all-wallets.action';
import { UpdateWalletAction } from './actions/update-wallet.action';
import { Wallet } from './entities/wallet.entity';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

/**
 * Módulo `wallets`.
 *
 * `CreateDefaultWalletAction` se exporta directamente (NO sólo a través
 * del service) para que `RegisterAction` lo inyecte y cree la wallet
 * "Efectivo" inicial dentro de SU transacción.
 *
 * Para cablearlo desde Auth:
 *   1. AuthModule.imports debe incluir WalletsModule.
 *   2. RegisterAction inyecta CreateDefaultWalletAction.
 *   3. Llama execute(manager, { companyId, createdBy }) tras crear el User.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Wallet]), FinancialMovementsModule],
  controllers: [WalletsController],
  providers: [
    WalletsService,
    FindAllWalletsAction,
    CreateWalletAction,
    UpdateWalletAction,
    ArchiveWalletAction,
    CreateDefaultWalletAction,
  ],
  exports: [WalletsService, CreateDefaultWalletAction, TypeOrmModule],
})
export class WalletsModule {}
