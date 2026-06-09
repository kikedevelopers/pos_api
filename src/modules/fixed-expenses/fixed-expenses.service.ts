import { Injectable } from '@nestjs/common';

import { ArchiveFixedExpenseAction } from './actions/archive-fixed-expense.action';
import {
  CreateFixedExpenseAction,
  type FixedExpenseActor,
} from './actions/create-fixed-expense.action';
import {
  FindAllFixedExpensesAction,
  type FindAllFixedExpensesResult,
} from './actions/find-all-fixed-expenses.action';
import { FindFixedExpenseAction } from './actions/find-fixed-expense.action';
import { ListFixedExpensePeriodsAction } from './actions/list-fixed-expense-periods.action';
import { MarkFixedExpensePeriodPaidAction } from './actions/mark-fixed-expense-period-paid.action';
import {
  PayFixedExpensePeriodsAction,
  type PayFixedExpensePeriodsResult,
} from './actions/pay-fixed-expense-periods.action';
import { UpdateFixedExpenseAction } from './actions/update-fixed-expense.action';
import type { CreateFixedExpenseDto } from './dto/create-fixed-expense.dto';
import type { PayFixedExpensePeriodDto } from './dto/pay-fixed-expense-period.dto';
import type { PayFixedExpensePeriodsDto } from './dto/pay-fixed-expense-periods.dto';
import type { UpdateFixedExpenseDto } from './dto/update-fixed-expense.dto';
import type { FixedExpensePeriod } from './entities/fixed-expense-period.entity';
import type { FixedExpense } from './entities/fixed-expense.entity';

export type { FixedExpenseActor } from './actions/create-fixed-expense.action';
export type { FindAllFixedExpensesResult } from './actions/find-all-fixed-expenses.action';

/**
 * Facade del módulo `fixed-expenses`. ZERO lógica — solo delega a las actions.
 */
@Injectable()
export class FixedExpensesService {
  constructor(
    private readonly findAllAction: FindAllFixedExpensesAction,
    private readonly findOneAction: FindFixedExpenseAction,
    private readonly createAction: CreateFixedExpenseAction,
    private readonly updateAction: UpdateFixedExpenseAction,
    private readonly archiveAction: ArchiveFixedExpenseAction,
    private readonly listPeriodsAction: ListFixedExpensePeriodsAction,
    private readonly markPeriodPaidAction: MarkFixedExpensePeriodPaidAction,
    private readonly payPeriodsAction: PayFixedExpensePeriodsAction,
  ) {}

  findAll(companyId: number): Promise<FindAllFixedExpensesResult> {
    return this.findAllAction.execute(companyId);
  }

  findOne(id: number, companyId: number): Promise<FixedExpense> {
    return this.findOneAction.execute(id, companyId);
  }

  create(
    dto: CreateFixedExpenseDto,
    companyId: number,
    actor: FixedExpenseActor,
  ): Promise<FixedExpense> {
    return this.createAction.execute(dto, companyId, actor);
  }

  update(id: number, companyId: number, dto: UpdateFixedExpenseDto): Promise<FixedExpense> {
    return this.updateAction.execute(id, companyId, dto);
  }

  archive(id: number, companyId: number): Promise<void> {
    return this.archiveAction.execute(id, companyId);
  }

  listPeriods(fixedExpenseId: number, companyId: number): Promise<FixedExpensePeriod[]> {
    return this.listPeriodsAction.execute(fixedExpenseId, companyId);
  }

  markPeriodPaid(
    fixedExpenseId: number,
    periodId: number,
    dto: PayFixedExpensePeriodDto,
    companyId: number,
    actor: FixedExpenseActor,
  ): Promise<FixedExpensePeriod> {
    return this.markPeriodPaidAction.execute(fixedExpenseId, periodId, dto, companyId, actor);
  }

  payPeriods(
    fixedExpenseId: number,
    dto: PayFixedExpensePeriodsDto,
    companyId: number,
    actor: FixedExpenseActor,
  ): Promise<PayFixedExpensePeriodsResult> {
    return this.payPeriodsAction.execute(fixedExpenseId, dto, companyId, actor);
  }
}
