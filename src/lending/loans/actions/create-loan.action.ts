import { randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { LoanPlan } from '@/lending/loan-plans/entities/loan-plan.entity';
import { LENDING_CUSTOMERS, type LendingCustomersPort } from '@/lending/ports/lending-customers.port';
import {
  LENDING_TREASURY,
  type DisbursementActor,
  type LendingTreasuryPort,
} from '@/lending/ports/lending-treasury.port';

import type { CreateLoanDto } from '../dto/create-loan.dto';
import { Loan } from '../entities/loan.entity';
import { computeLoanAmounts } from '../../domain/loan-amounts';
import { resolveLoanStartDate } from '../../domain/loan-start-date';

export type LoanActor = DisbursementActor;

export interface CreatedLoan {
  loan: Loan;
  customerName: string;
}

/**
 * Registra un préstamo (`POST /loans`) — una sola transacción:
 *
 *   1. Cliente activo de la company (puerto de clientes; 404 si no).
 *   2. Plan activo de la company (404 si no): sus condiciones se COPIAN al
 *      préstamo, con la cuota y el pago diario ya calculados.
 *   3. Fecha de inicio: hoy por defecto; no futura (400).
 *   4. Desembolso por el puerto de tesorería (lock + 422 por saldo).
 *   5. INSERT loans (saldo de capital = capital prestado).
 *
 * Nada queda a medias: ni dinero descontado sin préstamo ni préstamo sin
 * desembolso. Montos con Big.js.
 */
@Injectable()
export class CreateLoanAction {
  private readonly logger = new Logger(CreateLoanAction.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(LENDING_CUSTOMERS) private readonly customers: LendingCustomersPort,
    @Inject(LENDING_TREASURY) private readonly treasury: LendingTreasuryPort,
  ) {}

  async execute(dto: CreateLoanDto, companyId: number, actor: LoanActor): Promise<CreatedLoan> {
    const startDate = resolveLoanStartDate(dto.start_date);
    const principalBig = toBig(dto.principal);
    if (principalBig.lte(0)) {
      throw new BadRequestException('El monto del préstamo debe ser mayor que 0.');
    }
    const principal = preciseNumber(principalBig, 2);
    const referenceCode = `LOAN-${randomUUID()}`;
    const notes = dto.notes?.trim() || null;

    const created = await this.dataSource.transaction<CreatedLoan>(async (tx) => {
      const customer = await this.customers.findActive(companyId, dto.customer_id, tx);
      if (!customer) throw new NotFoundException('Cliente no encontrado.');

      const plan = await tx.findOne(LoanPlan, {
        where: { id: String(dto.loan_plan_id), company_id: String(companyId), is_archived: false },
      });
      if (!plan) throw new NotFoundException('Plan de préstamo no encontrado.');

      const amounts = computeLoanAmounts(
        {
          plan_type: plan.plan_type,
          interest_rate: Number(plan.interest_rate),
          installments_count: plan.installments_count,
          collection_days: plan.collection_days,
        },
        principal,
      );

      const { sourceName, resolvedSourceId } = await this.treasury.disburse(tx, {
        companyId,
        sourceType: dto.source_type,
        sourceId: dto.source_id,
        amount: principal,
        description: `Préstamo a ${customer.name}`,
        referenceCode,
        actor,
      });

      const repo = tx.getRepository(Loan);
      const loan = await repo.save(
        repo.create({
          company_id: String(companyId),
          customer_id: String(customer.id),
          loan_plan_id: plan.id,
          plan_name: plan.name,
          plan_type: plan.plan_type,
          interest_rate: String(plan.interest_rate),
          rate_period: plan.rate_period,
          installments_count: plan.installments_count,
          collection_days: plan.collection_days,
          principal: String(principal),
          outstanding_principal: String(principal),
          installment_amount:
            amounts.installment_amount === null ? null : String(amounts.installment_amount),
          daily_amount: amounts.daily_amount === null ? null : String(amounts.daily_amount),
          start_date: startDate,
          status: 'active',
          source_type: dto.source_type,
          source_id: String(resolvedSourceId),
          source_name: sourceName,
          reference_code: referenceCode,
          notes,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        }),
      );
      return { loan, customerName: customer.name };
    });

    this.logger.log({
      event: 'loan.created',
      companyId,
      loanId: Number(created.loan.id),
      customerId: dto.customer_id,
      planId: dto.loan_plan_id,
      principal,
      sourceType: dto.source_type,
      actorId: actor.id,
    });
    return created;
  }
}
