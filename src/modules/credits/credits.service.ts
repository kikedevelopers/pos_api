import { Injectable } from '@nestjs/common';

import type { ProcessCreditPaymentDto } from './dto/process-credit-payment.dto';
import {
  ProcessCreditPaymentAction,
  type CreditPaymentActor,
  type ProcessCreditPaymentResult,
} from './actions/process-credit-payment.action';

/**
 * Facade del módulo `credits`. Sin lógica — solo delega en `actions/`.
 *
 * Único método público:
 *   - `processCreditPayment` → `POST /credits` (paridad PlacePos
 *     `processCreditPayment`).
 */
@Injectable()
export class CreditsService {
  constructor(private readonly processCreditPaymentAction: ProcessCreditPaymentAction) {}

  processCreditPayment(
    dto: ProcessCreditPaymentDto,
    companyId: number,
    actor: CreditPaymentActor,
  ): Promise<ProcessCreditPaymentResult> {
    return this.processCreditPaymentAction.execute(dto, companyId, actor);
  }
}
