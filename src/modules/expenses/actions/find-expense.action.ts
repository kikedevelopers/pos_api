import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { findExpenseInCompany } from '../internal/expense-lookups';
import { Expense } from '../entities/expense.entity';

/**
 * Devuelve el detalle de un gasto. Lanza NotFoundException si no existe o
 * pertenece a otra company.
 */
@Injectable()
export class FindExpenseAction {
  constructor(
    @InjectRepository(Expense)
    private readonly expensesRepo: Repository<Expense>,
  ) {}

  execute(id: number, companyId: number): Promise<Expense> {
    return findExpenseInCompany(this.expensesRepo.manager, id, companyId);
  }
}
