import { Injectable } from '@nestjs/common';

import { CreateLoanAction, type CreatedLoan, type LoanActor } from './actions/create-loan.action';
import { FindAllLoansAction, type LoanFilters, type LoansWithCustomers } from './actions/find-all-loans.action';
import { FindLoanAction } from './actions/find-loan.action';
import type { CreateLoanDto } from './dto/create-loan.dto';
import type { Loan } from './entities/loan.entity';

/** Facade delgado del dominio `loans`. Solo delega a las actions. */
@Injectable()
export class LoansService {
  constructor(
    private readonly findAllAction: FindAllLoansAction,
    private readonly findOneAction: FindLoanAction,
    private readonly createAction: CreateLoanAction,
  ) {}

  findAll(companyId: number, filters: LoanFilters): Promise<LoansWithCustomers> {
    return this.findAllAction.execute(companyId, filters);
  }

  findOne(id: number, companyId: number): Promise<{ loan: Loan; customerName: string }> {
    return this.findOneAction.execute(id, companyId);
  }

  create(dto: CreateLoanDto, companyId: number, actor: LoanActor): Promise<CreatedLoan> {
    return this.createAction.execute(dto, companyId, actor);
  }
}
