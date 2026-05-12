import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CloseCashRegisterAction } from './actions/close-cash-register.action';
import { GetCashRegisterBalanceAction } from './actions/get-balance.action';
import { GetCurrentCashRegisterAction } from './actions/get-current-cash-register.action';
import { ListCashRegisterHistoryAction } from './actions/list-cash-register-history.action';
import { ListCashRegisterLogsAction } from './actions/list-cash-register-logs.action';
import { OpenCashRegisterAction } from './actions/open-cash-register.action';
import { CashRegisterController } from './cash-register.controller';
import { CashRegisterService } from './cash-register.service';
import { CashRegisterLog } from './entities/cash-register-log.entity';
import { CashRegister } from './entities/cash-register.entity';

/**
 * Módulo `cash-register`.
 *
 * Exporta el service + TypeOrmModule para que otros módulos
 * (`AccountsModule`, `SalesModule`) puedan inyectar el service o leer
 * directo las entidades (logs de caja generados por ventas, etc.).
 */
@Module({
  imports: [TypeOrmModule.forFeature([CashRegister, CashRegisterLog])],
  controllers: [CashRegisterController],
  providers: [
    CashRegisterService,
    OpenCashRegisterAction,
    CloseCashRegisterAction,
    GetCurrentCashRegisterAction,
    ListCashRegisterHistoryAction,
    GetCashRegisterBalanceAction,
    ListCashRegisterLogsAction,
  ],
  exports: [CashRegisterService, TypeOrmModule],
})
export class CashRegisterModule {}
