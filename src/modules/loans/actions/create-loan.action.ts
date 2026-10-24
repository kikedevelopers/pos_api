import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { LoanPlan } from '@/modules/loan-plans/entities/loan-plan.entity';

import type { CreateLoanDto } from '../dto/create-loan.dto';
import { Loan } from '../entities/loan.entity';
import { computeLoanAmounts } from '../internal/loan-amounts';
import { debitLoanSource, type LoanActor } from '../internal/debit-loan-source';
import { resolveLoanStartDate } from '../internal/loan-start-date';

/**
 * Registra un préstamo (`POST /loans`) — transacción atómica única:
 *
 *   1. Cliente activo de la company (404 si no).
 *   2. Plan activo de la company (404 si no): sus condiciones se COPIAN al
 *      préstamo, con la cuota y el pago diario ya calculados.
 *   3. Fecha de inicio: hoy por defecto; no futura (400).
 *   4. Desembolso: sale el dinero de la caja / banco / billetera con lock y
 *      validación de saldo (422 si no alcanza). Caja → log LOAN_DISBURSEMENT;
 *      banco/billetera → FinancialMovement EXPENSE con concepto
 *      LOAN_DISBURSEMENT y el `reference_code` del préstamo.
 *   5. INSERT loans (saldo de capital = capital prestado).
 *
 * Si algo falla, nada queda a medias: ni dinero descontado sin préstamo, ni
 * préstamo sin desembolso. Montos con Big.js.
 */
@Injectable()
export class CreateLoanAction {
  private readonly logger = new Logger(CreateLoanAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(dto: CreateLoanDto, companyId: number, actor: LoanActor): Promise<Loan> {
    const startDate = resolveLoanStartDate(dto.start_date);
    const principalBig = toBig(dto.principal);
    if (principalBig.lte(0)) {
      throw new BadRequestException('El monto del préstamo debe ser mayor que 0.');
    }
    const principal = preciseNumber(principalBig, 2);
    const referenceCode = `LOAN-${randomUUID()}`;
    const notes = dto.notes?.trim() || null;

    const saved = await this.dataSource.transaction<Loan>(async (manager) => {
      const customer = await manager.findOne(Customer, {
        where: { id: String(dto.customer_id), company_id: String(companyId), is_archived: false },
      });
      if (!customer) throw new NotFoundException('Cliente no encontrado.');

      const plan = await manager.findOne(LoanPlan, {
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

      const description = `Préstamo a ${customer.name}`;
      const { sourceName, resolvedSourceId } = await debitLoanSource(
        manager,
        dto.source_type,
        dto.source_id,
        companyId,
        principalBig,
        description,
        actor,
      );

      if (dto.source_type !== 'cash_register') {
        await this.financialMovementsService.record(manager, {
          companyId,
          amount: principal,
          movement_type: MovementType.EXPENSE,
          concept: MovementConcept.LOAN_DISBURSEMENT,
          description,
          source_type: dto.source_type,
          source_id: resolvedSourceId,
          reference_code: referenceCode,
          created_by: actor.fullName,
          created_by_id: actor.id,
        });
      }

      const repo = manager.getRepository(Loan);
      const loan = await repo.save(
        repo.create({
          company_id: String(companyId),
          customer_id: customer.id,
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
      loan.customer = customer;
      return loan;
    });

    this.logger.log({
      event: 'loan.created',
      companyId,
      loanId: Number(saved.id),
      customerId: dto.customer_id,
      planId: dto.loan_plan_id,
      principal,
      sourceType: dto.source_type,
      actorId: actor.id,
    });
    return saved;
  }
}
