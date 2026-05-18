import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GetCashRegisterBalanceAction } from './actions/get-balance.action';
import { ListCashRegisterLogsAction } from './actions/list-cash-register-logs.action';
import { CashRegisterController } from './cash-register.controller';
import { CashRegisterService } from './cash-register.service';
import { CashRegisterLog } from './entities/cash-register-log.entity';
import { CashRegister } from './entities/cash-register.entity';

/**
 * Módulo `cash-register`. Modelo PERMANENTE (paridad PlacePos): UNA caja por
 * `(company_id, user_id)`. Las entidades `CashRegister` y `CashRegisterLog`
 * permanecen registradas y exportadas porque otros módulos (sales,
 * credit-notes, expenses, purchases) leen y escriben en `cash_register_logs`
 * directamente como parte de sus transacciones, resolviendo la caja con el
 * helper `getOrCreateCashRegisterForUser`.
 *
 * Tip: el helper `getOrCreateCashRegisterForUser` se exporta como función
 * pura desde `internal/get-or-create-cash-register-for-user.helper.ts`; no
 * requiere inyección DI.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CashRegister, CashRegisterLog])],
  controllers: [CashRegisterController],
  providers: [CashRegisterService, GetCashRegisterBalanceAction, ListCashRegisterLogsAction],
  exports: [CashRegisterService, TypeOrmModule],
})
export class CashRegisterModule {}
