import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { LENDING_CUSTOMERS, type LendingCustomersPort } from '@/lending/ports/lending-customers.port';

import { Loan } from '../entities/loan.entity';

/** Un préstamo de la company (`GET /loans/:id`). 404 genérico cross-tenant. */
@Injectable()
export class FindLoanAction {
  constructor(
    @InjectRepository(Loan)
    private readonly repo: Repository<Loan>,
    @Inject(LENDING_CUSTOMERS) private readonly customers: LendingCustomersPort,
  ) {}

  async execute(id: number, companyId: number): Promise<{ loan: Loan; customerName: string }> {
    const loan = await this.repo.findOne({ where: { id: String(id), company_id: String(companyId) } });
    if (!loan) throw new NotFoundException('Préstamo no encontrado.');
    const names = await this.customers.namesByIds(companyId, [Number(loan.customer_id)]);
    return { loan, customerName: names.get(Number(loan.customer_id)) ?? '' };
  }
}
