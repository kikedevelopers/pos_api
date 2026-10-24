import { Module } from '@nestjs/common';

import { LoanPlansModule } from './loan-plans/loan-plans.module';
import { LoansModule } from './loans/loans.module';

/**
 * Contexto de PRÉSTAMOS (tipo de negocio prestamista). Punto de entrada único:
 * el POS solo lo registra en `AppModule`. Ver `src/lending/README.md`.
 */
@Module({
  imports: [LoanPlansModule, LoansModule],
})
export class LendingModule {}
