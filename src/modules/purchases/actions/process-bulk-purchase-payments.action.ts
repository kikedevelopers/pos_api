import {
  BadRequestException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { In, DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import type { BulkPurchasePaymentsDto } from '../dto/bulk-purchase-payments.dto';
import { PurchaseCredit, PurchaseCreditStatus } from '../entities/purchase-credit.entity';
import { Purchase } from '../entities/purchase.entity';
import {
  applyPurchasePayment,
  type ApplyPurchasePaymentActor,
} from '../internal/apply-purchase-payment.helper';

/**
 * Resultado por item del lote (espejo PlacePos).
 */
export interface BulkAppliedPurchasePayment {
  purchase_id: number;
  payment_id: number;
  payment_number: string;
  credit_status: PurchaseCreditStatus;
  credit_balance: number;
}

export interface ProcessBulkPurchasePaymentsResult {
  processed: number;
  payments: BulkAppliedPurchasePayment[];
}

/**
 * Procesa MULTIPLES abonos a compras en UNA sola transacción atómica. Espejo
 * de `POST /purchases/bulk-payments` en PlacePos (`purchases.routes.ts:883`).
 *
 * --------------------------------------------------------------------------
 * Garantía atómica
 * --------------------------------------------------------------------------
 *
 * Toda la operación corre dentro de `dataSource.transaction(SERIALIZABLE)`.
 * Si CUALQUIER abono falla (saldo insuficiente, monto excede balance, fuente
 * archivada, race uuid), la transacción aborta y NINGÚN pago, FinancialMovement
 * ni CashRegisterLog queda persistido. SERIALIZABLE protege contra anomalías
 * de lectura no-repetible cuando dos lotes simultáneos tocan las mismas
 * compras o las mismas cuentas (paridad CLAUDE.md §9.4).
 *
 * --------------------------------------------------------------------------
 * Pre-validación de saldos por compra (FAST FAIL)
 * --------------------------------------------------------------------------
 *
 * Antes de abrir la transacción, agrupamos los abonos por `purchase_id` y
 * verificamos que la suma no exceda el balance pendiente actual. Esto da
 * mensajes de error legibles (mencionando el `purchase_number`) sin gastar
 * lock-time. Dentro de la transacción cada abono individual REVALIDA contra
 * el lock — la pre-validación NO sustituye la defensa interna, solo evita
 * trabajo perdido cuando el lote es manifiestamente inválido.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * Las compras se cargan con filtro `company_id = ?` ANTES de la transacción.
 * Un id que no pertenece a la company devuelve 400 con el id como si "no
 * existiera". Defensa anti-IDOR cross-tenant: el atacante no puede saber si
 * el id pertenece a otra company vs no existe.
 */
@Injectable()
export class ProcessBulkPurchasePaymentsAction {
  private readonly logger = new Logger(ProcessBulkPurchasePaymentsAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    dto: BulkPurchasePaymentsDto,
    companyId: number,
    actor: ApplyPurchasePaymentActor,
  ): Promise<ProcessBulkPurchasePaymentsResult> {
    const items = dto.payments;

    // 0. Rechazar uuid duplicados en el mismo batch. Sin esto, el segundo
    //    item con el mismo uuid entraría por el fast-path idempotente de
    //    `applyPurchasePayment` y devolvería el `payment_id` del primero —
    //    no es un duplicado de cobro, pero sí un payload mal formado del
    //    cliente que enmascara un bug aguas arriba. Sólo validamos los uuid
    //    que vienen DEL CLIENTE; si el campo viene vacío el helper genera
    //    uno por item (siempre único).
    const seenUuids = new Set<string>();
    for (const it of items) {
      if (!it.uuid) {
        continue;
      }
      if (seenUuids.has(it.uuid)) {
        throw new UnprocessableEntityException({
          message: `uuid duplicado en el lote: ${it.uuid}`,
          payload: { code: 'DUPLICATE_UUID_IN_BATCH' },
        });
      }
      seenUuids.add(it.uuid);
    }

    // 1. Agrupar por purchase_id y sumar montos. Detecta sobrepagos sin abrir
    //    transacción.
    const totalsByPurchase = new Map<number, Big>();
    for (const it of items) {
      const prev = totalsByPurchase.get(it.purchase_id) ?? toBig(0);
      totalsByPurchase.set(it.purchase_id, prev.plus(toBig(it.amount)));
    }

    // 2. Cargar todas las compras candidatas con company_id (defensa
    //    multi-tenant) Y los créditos asociados. Sirve para validar
    //    saldos suficientes antes de la transacción.
    const purchaseIds = Array.from(totalsByPurchase.keys()).map((id) => String(id));
    const purchases = await this.dataSource.getRepository(Purchase).find({
      where: {
        id: In(purchaseIds),
        company_id: String(companyId),
        is_deleted: false,
      },
      select: { id: true, purchase_number: true },
    });
    const purchaseById = new Map<number, { id: number; purchase_number: string }>();
    for (const p of purchases) {
      purchaseById.set(Number(p.id), {
        id: Number(p.id),
        purchase_number: p.purchase_number,
      });
    }

    const credits = await this.dataSource.getRepository(PurchaseCredit).find({
      where: {
        purchase_id: In(purchaseIds),
        company_id: String(companyId),
      },
    });
    const creditByPurchase = new Map<number, PurchaseCredit>();
    for (const c of credits) {
      creditByPurchase.set(Number(c.purchase_id), c);
    }

    // 3. Validar cada (purchase_id, sumAmount).
    for (const [purchaseId, sumBig] of totalsByPurchase.entries()) {
      const purchase = purchaseById.get(purchaseId);
      if (!purchase) {
        throw new BadRequestException(`Compra ${purchaseId} no encontrada o archivada`);
      }
      const credit = creditByPurchase.get(purchaseId);
      if (!credit) {
        throw new BadRequestException(
          `Compra ${purchase.purchase_number} no tiene crédito asociado`,
        );
      }
      const balanceBig = toBig(credit.balance);
      if (credit.status === PurchaseCreditStatus.PAID || balanceBig.lte(0)) {
        throw new BadRequestException(
          `Compra ${purchase.purchase_number} ya está pagada en su totalidad`,
        );
      }
      if (sumBig.gt(balanceBig)) {
        throw new BadRequestException(
          `La suma de abonos para la compra ${purchase.purchase_number} ($${sumBig.toFixed(2)}) excede el saldo disponible ($${balanceBig.toFixed(2)})`,
        );
      }
    }

    // 4. Una transacción SERIALIZABLE envuelve todos los abonos. Si uno
    //    falla, TypeORM hace rollback total.
    const applied = await this.dataSource.transaction<BulkAppliedPurchasePayment[]>(
      'SERIALIZABLE',
      async (manager) => {
        const results: BulkAppliedPurchasePayment[] = [];
        for (const it of items) {
          const r = await applyPurchasePayment(
            manager,
            companyId,
            {
              purchaseId: it.purchase_id,
              source_type: it.source_type,
              source_id: it.source_id,
              amount: it.amount,
              notes: it.notes ?? null,
              uuid: it.uuid ?? null,
            },
            actor,
            this.financialMovementsService,
          );
          // Si el helper detectó idempotencia (uuid ya procesado), devolvemos
          // el row existente sin reaplicar — mismo comportamiento que PlacePos
          // (no duplica el cobro). Lo incluimos en el conteo de procesados
          // para que el cliente vea N==items.length.
          if (r.idempotent) {
            // Defensa: si el cliente envía un uuid ya usado por OTRA compra,
            // applyPurchasePayment lanza 422 antes de llegar aquí.
            this.logger.warn({
              event: 'purchase.bulk_payment_idempotent_hit',
              companyId,
              purchaseId: it.purchase_id,
              paymentNumber: r.payment.payment_number,
            });
          }
          results.push({
            purchase_id: it.purchase_id,
            payment_id: Number(r.payment.id),
            payment_number: r.payment.payment_number,
            credit_status: r.credit_status,
            credit_balance: r.credit_balance,
          });
        }
        return results;
      },
    );

    this.logger.log({
      event: 'purchase.bulk_payments_processed',
      companyId,
      count: applied.length,
      actorId: actor.id,
    });

    return {
      processed: applied.length,
      payments: applied,
    };
  }
}
