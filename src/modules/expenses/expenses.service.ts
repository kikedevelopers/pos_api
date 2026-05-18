import { Injectable } from '@nestjs/common';

import { CreateExpenseAction } from './actions/create-expense.action';
import { FindAllExpensesAction, type ListExpensesResult } from './actions/find-all-expenses.action';
import { FindExpenseAction } from './actions/find-expense.action';
import {
  GetExpensePaymentMethodsAction,
  type ExpensePaymentMethodsResponse,
} from './actions/get-expense-payment-methods.action';
import { UpdateExpenseAction } from './actions/update-expense.action';
import { VoidExpenseAction } from './actions/void-expense.action';
import type { CreateExpenseDto } from './dto/create-expense.dto';
import type { ListExpensesQueryDto } from './dto/list-expenses-query.dto';
import type { UpdateExpenseDto } from './dto/update-expense.dto';
import type { Expense } from './entities/expense.entity';
import type { ExpenseActor } from './internal/debit-expense-source';

export type { ExpenseActor } from './internal/debit-expense-source';
export type { ListExpensesResult } from './actions/find-all-expenses.action';
export type { ExpensePaymentMethodsResponse } from './actions/get-expense-payment-methods.action';

/**
 * Facade del módulo `expenses`. ZERO lógica — solo delega a las actions.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly findAllExpensesAction: FindAllExpensesAction,
    private readonly findExpenseAction: FindExpenseAction,
    private readonly createExpenseAction: CreateExpenseAction,
    private readonly updateExpenseAction: UpdateExpenseAction,
    private readonly voidExpenseAction: VoidExpenseAction,
    private readonly getExpensePaymentMethodsAction: GetExpensePaymentMethodsAction,
  ) {}

  findAll(companyId: number, query: ListExpensesQueryDto): Promise<ListExpensesResult> {
    return this.findAllExpensesAction.execute(companyId, query);
  }

  getPaymentMethods(companyId: number, userId: number): Promise<ExpensePaymentMethodsResponse> {
    return this.getExpensePaymentMethodsAction.execute(companyId, userId);
  }

  findOne(id: number, companyId: number): Promise<Expense> {
    return this.findExpenseAction.execute(id, companyId);
  }

  create(dto: CreateExpenseDto, companyId: number, actor: ExpenseActor): Promise<Expense> {
    return this.createExpenseAction.execute(dto, companyId, actor);
  }

  update(id: number, dto: UpdateExpenseDto, companyId: number): Promise<Expense> {
    return this.updateExpenseAction.execute(id, dto, companyId);
  }

  void(id: number, companyId: number, actor: ExpenseActor): Promise<void> {
    return this.voidExpenseAction.execute(id, companyId, actor);
  }
}
