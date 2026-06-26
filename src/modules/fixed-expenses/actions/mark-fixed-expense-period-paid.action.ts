import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import type { FixedExpensePeriodResponseDto } from '../dto/fixed-expense-period-response.dto';
import type { PayFixedExpensePeriodDto } from '../dto/pay-fixed-expense-period.dto';
import { FixedExpensePeriod } from '../entities/fixed-expense-period.entity';

import type { FixedExpenseActor } from './create-fixed-expense.action';
import { PayFixedExpensePeriodsAction } from './pay-fixed-expense-periods.action';

/**
 * Marca UN corte (`FixedExpensePeriod`) como PAGADO en su totalidad. Endpoint
 * legacy `PUT /fixed-expenses/:id/periods/:periodId/pay` mantenido por compat.
 *
 * Tras §4 del contrato `CONTRACT_fixed_expense_periods_pay.md` esta acción
 * DELEGA en `PayFixedExpensePeriodsAction` (el canónico multi-corte/parcial):
 * resuelve el saldo pendiente del corte y dispara un pago total de ese único
 * corte. Así toda la mecánica financiera (debitar fuente, materializar Expense,
 * FinancialMovement, invariantes paid_amount/balance/status) vive en un solo
 * sitio y no diverge.
 *
 * Multi-tenancy: el lookup del corte y la acción delegada filtran por
 * `company_id`.
 */
@Injectable()
export class MarkFixedExpensePeriodPaidAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly payPeriodsAction: PayFixedExpensePeriodsAction,
  ) {}

  async execute(
    fixedExpenseId: number,
    periodId: number,
    dto: PayFixedExpensePeriodDto,
    companyId: number,
    actor: FixedExpenseActor,
  ): Promise<FixedExpensePeriodResponseDto> {
    // Resolver el saldo pendiente del corte (anti-IDOR por company_id).
    const period = await this.dataSource.getRepository(FixedExpensePeriod).findOne({
      where: {
        id: String(periodId),
        fixed_expense_id: String(fixedExpenseId),
        company_id: String(companyId),
      },
    });
    if (!period) {
      throw new NotFoundException('Corte no encontrado.');
    }
    const balance = toBig(period.balance);
    if (balance.lte(0)) {
      throw new UnprocessableEntityException('El corte ya está marcado como pagado.');
    }

    // Pago total de este único corte (amount = saldo pendiente).
    const { periods } = await this.payPeriodsAction.execute(
      fixedExpenseId,
      {
        source_type: dto.source_type,
        source_id: dto.source_id,
        amount: Number(balance.toFixed(2)),
        period_ids: [periodId],
      },
      companyId,
      actor,
    );

    const updated = periods.find((p) => p.id === periodId);
    if (!updated) {
      // No debería ocurrir: el corte pertenece al gasto.
      throw new NotFoundException('Corte no encontrado tras el pago.');
    }
    return updated;
  }
}
