import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import type { CreatePurchasePaymentDto } from '../dto/create-purchase-payment.dto';
import { PurchasePayment } from '../entities/purchase-payment.entity';
import {
  applyPurchasePayment,
  type ApplyPurchasePaymentActor,
} from '../internal/apply-purchase-payment.helper';
import {
  findPurchaseCredit,
  findPurchaseInCompany,
  findPurchaseLines,
  findPurchasePayments,
} from '../internal/purchase-lookups';
import type { PurchaseAggregate } from './find-purchase.action';

/**
 * Actor que registra el pago (snapshot guardado en `created_by`/`created_by_id`).
 */
export type PurchasePaymentActor = ApplyPurchasePaymentActor;

/**
 * Resultado del registro. Incluye un flag `idempotent` para que el controller
 * pueda responder con el status apropiado:
 *   - Nuevo pago: 201.
 *   - Pago ya procesado (uuid existente): 200.
 */
export interface RegisterPurchasePaymentResult {
  aggregate: PurchaseAggregate;
  payment: PurchasePayment;
  idempotent: boolean;
}

/**
 * Registra un abono a una compra. Espejo `POST /purchases/:id/payments` de
 * PlacePos. Internamente delega en `applyPurchasePayment` (helper compartido
 * con el flujo bulk) para mantener una sola fuente de verdad sobre la
 * mecánica del abono.
 *
 * --------------------------------------------------------------------------
 * Transacción
 * --------------------------------------------------------------------------
 *
 * El single payment usa `READ COMMITTED` (default de PostgreSQL). El helper
 * usa lock pessimistic_write sobre PurchaseCredit y la cuenta origen para
 * serializar pagos concurrentes. SERIALIZABLE solo se necesita en flujos
 * que combinan múltiples reads no-repetibles (bulk + edit purchase).
 *
 * --------------------------------------------------------------------------
 * Idempotencia
 * --------------------------------------------------------------------------
 *
 * El helper detecta uuid duplicado (fast-path) y race-condition (SQLSTATE
 * 23505 sobre el unique parcial). Cuando devuelve `idempotent: true`, el
 * controller responde 200 (no 201).
 */
@Injectable()
export class RegisterPurchasePaymentAction {
  private readonly logger = new Logger(RegisterPurchasePaymentAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    purchaseId: number,
    dto: CreatePurchasePaymentDto,
    companyId: number,
    actor: PurchasePaymentActor,
  ): Promise<RegisterPurchasePaymentResult> {
    return this.dataSource.transaction<RegisterPurchasePaymentResult>(async (manager) => {
      const result = await applyPurchasePayment(
        manager,
        companyId,
        {
          purchaseId,
          source_type: dto.source_type,
          source_id: dto.source_id,
          amount: dto.amount,
          notes: dto.notes ?? null,
          uuid: dto.uuid ?? null,
        },
        actor,
        this.financialMovementsService,
      );

      // Cargar aggregate completo para devolverlo al controller.
      const purchase = await findPurchaseInCompany(manager, purchaseId, companyId);
      const lines = await findPurchaseLines(manager, purchaseId, companyId);
      const credit = await findPurchaseCredit(manager, purchaseId, companyId);
      const payments = await findPurchasePayments(manager, purchaseId, companyId);

      this.logger.log({
        event: 'purchase.payment_registered',
        companyId,
        purchaseId,
        paymentId: Number(result.payment.id),
        paymentNumber: result.payment.payment_number,
        idempotent: result.idempotent,
        actorId: actor.id,
      });

      return {
        aggregate: { purchase, lines, credit, payments },
        payment: result.payment,
        idempotent: result.idempotent,
      };
    });
  }
}
