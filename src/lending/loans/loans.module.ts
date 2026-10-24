import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PosLendingIntegrationModule } from '@/lending/integration/pos/pos-lending-integration.module';

import { CreateLoanAction } from './actions/create-loan.action';
import { FindAllLoansAction } from './actions/find-all-loans.action';
import { FindLoanAction } from './actions/find-loan.action';
import { Loan } from './entities/loan.entity';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

/**
 * Préstamos. Lo que necesita del exterior (clientes, tesorería, tenant,
 * permisos) llega por `PosLendingIntegrationModule`: aquí no se importa
 * ningún módulo del POS.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Loan]), PosLendingIntegrationModule],
  controllers: [LoansController],
  providers: [LoansService, FindAllLoansAction, FindLoanAction, CreateLoanAction],
})
export class LoansModule {}
