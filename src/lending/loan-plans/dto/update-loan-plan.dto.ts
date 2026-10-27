import { PartialType } from '@nestjs/swagger';

import { CreateLoanPlanDto } from './create-loan-plan.dto';

/**
 * Payload de `PUT /loan-plans/:id`: cambio parcial. La action lo mezcla con el
 * plan guardado y valida el RESULTADO completo con `normalizeLoanPlan`.
 */
export class UpdateLoanPlanDto extends PartialType(CreateLoanPlanDto) {}
