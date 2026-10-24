import { Injectable } from '@nestjs/common';

import { CreateLoanAction } from './actions/create-loan.action';
import { FindAllLoansAction, type LoanFilters } from './actions/find-all-loans.action';
import { FindLoanAction } from './actions/find-loan.action';
import type { CreateLoanDto } from './dto/create-loan.dto';
import type { Loan } from './entities/loan.entity';
import type { LoanActor } from './internal/debit-loan-source';

/** Facade delgado del dominio `loans`. Solo delega a las actions. */
@Injectable()
export class LoansService {
  constructor(
    private readonly findAllAction: FindAllLoansAction,
    private readonly findOneAction: FindLoanAction,
    private readonly createAction: CreateLoanAction,
  ) {}

  findAll(companyId: number, filters: LoanFilters): Promise<Loan[]> {
    return this.findAllAction.execute(companyId, filters);
  }

  findOne(id: number, companyId: number): Promise<Loan> {
    return this.findOneAction.execute(id, companyId);
  }

  create(dto: CreateLoanDto, companyId: number, actor: LoanActor): Promise<Loan> {
    return this.createAction.execute(dto, companyId, actor);
  }
}
