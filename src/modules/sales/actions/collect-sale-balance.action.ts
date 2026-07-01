import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import type { CollectSaleBalanceDto, CollectSaleTenderDto } from '../dto/collect-sale-balance.dto';
import { SaleCredit, SaleCreditStatus } from '../entities/sale-credit.entity';
import { TicketType } from '../entities/sale-invoice.entity';
import { SalePayment, SalePaymentMethod } from '../entities/sale-payment.entity';
import { SaleStatusEventType } from '../entities/sale-status-history.entity';
import { applySalePayment, type SalePaymentActor } from '../internal/apply-sale-payment';
import { recordSaleStatus } from '../internal/record-sale-status.helper';
import {
  loadSaleForSettlement,
  recomputeSaleSettlement,
  sumLivePayments,
} from '../internal/recompute-sale-settlement';

export interface CollectSaleActor {
  id: number;
  fullName: string;
  type: string | null;
}

export type SettlementStatusLabel = 'PENDING' | 'PARTIAL' | 'PAID';

export interface CollectSaleBalanceResult {
  success: true;
  message: string;
  payment_ids: number[];
  sale_balance: number;
  credit_status: SettlementStatusLabel;
  replay?: boolean;
}

/**
 * Re-cobra el saldo pendiente de una venta SALE — espejo placepos. NO regenera
 * folio ni descuenta inventario (la venta ya es SALE). Reutiliza
 * `applySalePayment` para insertar cada SalePayment + acreditar su destino
 * (efectivo → caja del ACTOR; transfer → banco), y recomputa el settlement.
 *
 * --------------------------------------------------------------------------
 * Flujo atómico (UNA transacción, SERIALIZABLE)
 * --------------------------------------------------------------------------
 *
 *   1. Lock de la venta (SALE no anulada).
 *   2. saldo = total − Σ(netos de pagos vivos). Rechaza si saldo ≤ 0.
 *   3. Validar Σ(netos de tenders) ≤ saldo + 0.01.
 *   4. Por cada tender: resolver destino y `applySalePayment` (idempotente).
 *   5. Recompute settlement.
 *
 * Idempotencia: el tender 0 usa `client_operation_id` como uuid; los siguientes
 * derivan `${client_operation_id}:${i}`. El UNIQUE (company_id, uuid) sobre
 * sale_payments deduplica el re-cobro completo ante reintentos.
 */
@Injectable()
export class CollectSaleBalanceAction {
  private readonly logger = new Logger(CollectSaleBalanceAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    saleId: number,
    dto: CollectSaleBalanceDto,
    companyId: number,
    actor: CollectSaleActor,
  ): Promise<CollectSaleBalanceResult> {
    return this.dataSource.transaction<CollectSaleBalanceResult>(
      'SERIALIZABLE',
      async (manager) => {
        // 1. Lock de la venta. Debe ser SALE (no ORDER) y no anulada.
        const sale = await loadSaleForSettlement(manager, saleId, companyId);
        if (sale.ticket_type !== TicketType.SALE) {
          throw new UnprocessableEntityException({
            message: 'Solo se puede re-cobrar el saldo de una venta confirmada (SALE).',
            payload: { code: 'INVOICE_NOT_SALE' },
          });
        }

        // Lock del SaleCredit (si existe) — lo necesita el recompute al final.
        const credit = await manager.findOne(SaleCredit, {
          where: { sale_invoice_id: sale.id, company_id: String(companyId) },
          lock: { mode: 'pessimistic_write' },
        });

        // 2. Saldo actual = total − Σ(netos de pagos vivos).
        const livePayments = await manager.find(SalePayment, {
          where: { sale_invoice_id: sale.id, company_id: String(companyId), is_voided: false },
        });
        const livePaid = sumLivePayments(livePayments);
        const balanceBig = toBig(sale.total).minus(toBig(livePaid));
        if (balanceBig.lte(0)) {
          throw new UnprocessableEntityException({
            message: 'La venta no tiene saldo pendiente por cobrar.',
            payload: { code: 'NO_BALANCE_DUE' },
          });
        }

        // 3. Validar tenders y cuadre.
        const tenders = dto.payments;
        let tenderNetBig = toBig(0);
        for (const t of tenders) {
          const paidBig = toBig(t.amount_paid);
          const changeBig = toBig(t.change_amount ?? 0);
          if (paidBig.lte(0)) {
            throw new UnprocessableEntityException({
              message: 'Cada método de pago debe tener un monto mayor a cero.',
              payload: { code: 'INVALID_PAYMENT_ITEM' },
            });
          }
          if (changeBig.lt(0) || changeBig.gt(paidBig)) {
            throw new UnprocessableEntityException({
              message: 'El vuelto es inválido.',
              payload: { code: 'INVALID_CHANGE_AMOUNT' },
            });
          }
          if (t.payment_method === SalePaymentMethod.TRANSFER && changeBig.gt(0)) {
            throw new UnprocessableEntityException({
              message: 'El pago por transferencia no admite vuelto.',
              payload: { code: 'INVALID_CHANGE_AMOUNT' },
            });
          }
          if (t.payment_method === SalePaymentMethod.TRANSFER && !t.bank_id) {
            throw new UnprocessableEntityException({
              message: 'El pago por transferencia requiere un banco receptor.',
              payload: { code: 'TRANSFER_REQUIRES_BANK' },
            });
          }
          tenderNetBig = tenderNetBig.plus(paidBig.minus(changeBig));
        }
        if (tenderNetBig.minus(balanceBig).gt(toBig(0.01))) {
          throw new UnprocessableEntityException({
            message: 'El monto a cobrar excede el saldo pendiente de la venta.',
            payload: {
              code: 'AMOUNT_EXCEEDS_BALANCE',
              required: preciseNumber(tenderNetBig, 2),
              available: preciseNumber(balanceBig, 2),
            },
          });
        }

        // 4. Insertar pagos + acreditar destinos (reutiliza applySalePayment).
        const paymentActor: SalePaymentActor = { id: actor.id, fullName: actor.fullName };
        const ticketReference = sale.sale_number ?? sale.ticket_number;
        const customerId =
          sale.customer_id !== null && sale.customer_id !== undefined
            ? Number(sale.customer_id)
            : null;

        const paymentIds: number[] = [];
        for (let i = 0; i < tenders.length; i += 1) {
          const tender = tenders[i];
          const { accountType, accountId } = await this.resolveDestination(
            manager,
            tender,
            companyId,
            actor,
          );
          const tenderUuid = this.deriveTenderUuid(dto.client_operation_id ?? null, i);
          const result = await applySalePayment(manager, this.financialMovementsService, {
            saleId: Number(sale.id),
            companyId,
            ticketReference,
            customerId,
            account_type: accountType,
            account_id: accountId,
            amount: tender.amount_paid,
            change_amount: tender.change_amount ?? 0,
            uuid: tenderUuid,
            actor: paymentActor,
          });
          paymentIds.push(Number(result.payment.id));
        }

        // 5. Recompute settlement.
        const settlement = await recomputeSaleSettlement(manager, sale, companyId, credit);

        // HISTORIAL: re-cobro del saldo de una venta ya confirmada.
        //  - Sin crédito (saldo derivado re-cobrable) → COLLECTED.
        //  - Con crédito → INSTALLMENT (abono), y PAID si con este cobro se saldó.
        // Coincide con la semántica del backfill (pago sobre venta con crédito =
        // abono; sin crédito = cobro). Monto = NETO cobrado por tenders.
        const collectedNet = preciseNumber(tenderNetBig, 2);
        if (credit) {
          await recordSaleStatus(manager, {
            companyId,
            saleInvoiceId: Number(sale.id),
            eventType: SaleStatusEventType.INSTALLMENT,
            amount: collectedNet,
            createdBy: actor.fullName,
          });
          if (settlement.status === SaleCreditStatus.PAID) {
            await recordSaleStatus(manager, {
              companyId,
              saleInvoiceId: Number(sale.id),
              eventType: SaleStatusEventType.PAID,
              createdBy: actor.fullName,
            });
          }
        } else {
          await recordSaleStatus(manager, {
            companyId,
            saleInvoiceId: Number(sale.id),
            eventType: SaleStatusEventType.COLLECTED,
            amount: collectedNet,
            createdBy: actor.fullName,
          });
        }

        this.logger.log({
          event: 'sale.balance.collected',
          companyId,
          saleId,
          tenderCount: tenders.length,
          paymentIds,
          salePaid: settlement.paid,
          saleBalance: settlement.balance,
          creditStatus: settlement.status,
          actorId: actor.id,
        });

        return {
          success: true,
          message:
            settlement.balance <= 0
              ? 'Saldo cobrado completamente'
              : `Cobro registrado. Saldo pendiente: $${settlement.balance}`,
          payment_ids: paymentIds,
          sale_balance: settlement.balance,
          credit_status: this.toStatusLabel(settlement.status),
        };
      },
    );
  }

  /**
   * Resuelve el destino del tender para `applySalePayment`:
   *   - CASH → caja del ACTOR (getOrCreate, lockeada dentro del helper al
   *     aplicar). Aquí solo necesitamos su id.
   *   - TRANSFER → bank.id (valida ownership multi-tenant + no archivado).
   */
  private async resolveDestination(
    manager: EntityManager,
    tender: CollectSaleTenderDto,
    companyId: number,
    actor: CollectSaleActor,
  ): Promise<{ accountType: 'cash_register' | 'bank'; accountId: number }> {
    if (tender.payment_method === SalePaymentMethod.TRANSFER) {
      const bank = await manager.findOne(Bank, {
        where: {
          id: String(tender.bank_id),
          company_id: String(companyId),
          is_archived: false,
        },
        select: { id: true },
      });
      if (!bank) {
        throw new UnprocessableEntityException({
          message: 'Cuenta bancaria no encontrada.',
          payload: { code: 'BANK_NOT_FOUND' },
        });
      }
      return { accountType: 'bank', accountId: Number(bank.id) };
    }
    // CASH → caja del actor.
    const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
    if (!register) {
      throw new NotFoundException('No se pudo resolver la caja del usuario.');
    }
    return { accountType: 'cash_register', accountId: Number(register.id) };
  }

  /**
   * Deriva el uuid idempotente del tender. El tender 0 usa la llave de
   * operación pura; los siguientes derivan `${key}:${i}`.
   */
  private deriveTenderUuid(clientOperationId: string | null, index: number): string {
    if (!clientOperationId) {
      return randomUUID();
    }
    return index === 0 ? clientOperationId : `${clientOperationId}:${index}`;
  }

  private toStatusLabel(status: SaleCreditStatus): SettlementStatusLabel {
    switch (status) {
      case SaleCreditStatus.PENDING:
        return 'PENDING';
      case SaleCreditStatus.PARTIALLY_PAID:
        return 'PARTIAL';
      case SaleCreditStatus.PAID:
        return 'PAID';
    }
  }
}
