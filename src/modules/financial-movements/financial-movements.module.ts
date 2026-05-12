import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ListFinancialMovementsAction } from './actions/list-financial-movements.action';
import { RecordFinancialMovementAction } from './actions/record-financial-movement.action';
import { FinancialMovement } from './entities/financial-movement.entity';
import { FinancialMovementsController } from './financial-movements.controller';
import { FinancialMovementsService } from './financial-movements.service';

/**
 * Módulo `financial-movements`.
 *
 * Exporta `FinancialMovementsService` para que `BanksModule`,
 * `WalletsModule`, `AccountsModule`, `SalesModule`, etc., puedan
 * inyectarlo y registrar movimientos dentro de SUS transacciones.
 *
 * Reexporta TypeOrmModule para que reportes lean la entidad sin
 * `forFeature` redundante.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FinancialMovement])],
  controllers: [FinancialMovementsController],
  providers: [
    FinancialMovementsService,
    ListFinancialMovementsAction,
    RecordFinancialMovementAction,
  ],
  exports: [FinancialMovementsService, TypeOrmModule],
})
export class FinancialMovementsModule {}
