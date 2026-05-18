import { Injectable } from '@nestjs/common';

import {
  ProcessPaymentAction,
  type ProcessPaymentActor,
  type ProcessPaymentResult,
} from './actions/process-payment.action';
import { ProcessPaymentDto } from './dto/process-payment.dto';

/**
 * Facade del módulo `payments`. Sin lógica — solo delega al action.
 *
 * Mantiene el patrón CLAUDE.md §3.1: el controller inyecta el service, no
 * los actions directamente. Esto preserva la firma del contrato y deja la
 * lógica concentrada en `ProcessPaymentAction.execute`.
 */
@Injectable()
export class PaymentsService {
  constructor(private readonly processPaymentAction: ProcessPaymentAction) {}

  process(
    dto: ProcessPaymentDto,
    companyId: number,
    actor: ProcessPaymentActor,
    idempotencyKey?: string | null,
  ): Promise<ProcessPaymentResult> {
    return this.processPaymentAction.execute(dto, companyId, actor, idempotencyKey);
  }
}
