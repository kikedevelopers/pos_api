import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';

import { ArchiveBankAction } from './actions/archive-bank.action';
import { CreateBankAction } from './actions/create-bank.action';
import { FindAllBanksAction } from './actions/find-all-banks.action';
import { UpdateBankAction } from './actions/update-bank.action';
import { BanksController } from './banks.controller';
import { BanksService } from './banks.service';
import { Bank } from './entities/bank.entity';

/**
 * Módulo `banks`.
 *
 * Importa `FinancialMovementsModule` para que `CreateBankAction` pueda
 * inyectar `FinancialMovementsService` y registrar el INITIAL_BALANCE
 * dentro de la misma transacción del INSERT del bank.
 *
 * Exporta el service para que `AccountsModule` (transferencias) reutilice
 * los lookups y modificaciones de balance bancarios.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Bank]), FinancialMovementsModule],
  controllers: [BanksController],
  providers: [
    BanksService,
    FindAllBanksAction,
    CreateBankAction,
    UpdateBankAction,
    ArchiveBankAction,
  ],
  exports: [BanksService, TypeOrmModule],
})
export class BanksModule {}
