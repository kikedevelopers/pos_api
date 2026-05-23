import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { UsersModule } from '@/modules/users/users.module';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import { GetCashSourcesAction } from './actions/get-cash-sources.action';
import { CashSourcesController } from './cash-sources.controller';
import { CashSourcesService } from './cash-sources.service';

/**
 * Módulo `cash-sources`.
 *
 * Reusa entidades `Wallet`, `Bank`, `CashRegister` registradas en sus módulos
 * respectivos. La caja del actor se resuelve directamente por
 * `(company_id, user_id)` en el modelo PERMANENTE — sin facade adicional. El
 * `User` se importa vía `UsersModule` (que reexporta TypeOrmModule) para
 * construir la etiqueta "Caja de Nombre Apellido" con paridad PlacePos.
 *
 * NO requiere migración nueva — el endpoint compone datos de tablas
 * existentes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Wallet, Bank, CashRegister]), UsersModule],
  controllers: [CashSourcesController],
  providers: [CashSourcesService, GetCashSourcesAction],
  exports: [CashSourcesService],
})
export class CashSourcesModule {}
