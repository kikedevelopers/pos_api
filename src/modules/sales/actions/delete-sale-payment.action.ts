import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type Big from 'big.js';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import {
  AccountReference,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import { SaleCredit, SaleCreditStatus } from '../entities/sale-credit.entity';
import { SalePayment } from '../entities/sale-payment.entity';
import {
  loadSaleForSettlement,
  recomputeSaleSettlement,
} from '../internal/recompute-sale-settlement';

/**
 * Actor que ejecuta el reverso. Se persiste en el pago (voided_by/_id), en el
 * log de caja y en el FinancialMovement.
 */
export interface DeleteSalePaymentActor {
  id: number;
  fullName: string;
  type: string | null;
}

/**
 * Status del crédito devuelto al cliente — mismo label que placepos
 * (`PENDING | PARTIAL | PAID`), o `null` si la venta quedó pagada/ sin crédito.
 */
export type SettlementStatusLabel = 'PENDING' | 'PARTIAL' | 'PAID';

export interface DeleteSalePaymentResult {
  success: true;
  message: string;
  payment_id: number;
  reversed_amount: number;
  sale_balance: number;
  credit_status: SettlementStatusLabel;
  /** true si el reverso ya estaba aplicado (replay idempotente). */
  replay?: boolean;
}

/**
 * Reversa (soft-delete) un pago individual de una venta y devuelve el dinero a
 * la cuenta ORIGINAL del pago. Espejo placepos. Calco del patrón de
 * `void-sale.action.ts`.
 *
 * --------------------------------------------------------------------------
 * Flujo atómico (UNA transacción, SERIALIZABLE)
 * --------------------------------------------------------------------------
 *
 *   1. Lock pessimistic_write del SalePayment por (id, sale_invoice_id,
 *      company_id). 404 si no existe.
 *   2. Fast-path idempotente: si `is_voided = true`, el reverso ya se aplicó.
 *      Devolvemos el resultado previo (replay) sin descontar la cuenta de nuevo.
 *   3. Lock de la venta (SALE no anulada) vía `loadSaleForSettlement`.
 *   4. Lock del SaleCredit (si existe).
 *   5. Reverso del NETO (amount − change_amount) a la cuenta ORIGINAL leída del
 *      propio pago (account_type / account_id; bank_id para snapshot):
 *        - cash_register → descuenta de la caja account_id (la ORIGINAL, puede
 *          ser de otro usuario). Validación de fondos ANTES del UPDATE
 *          (CHECK balance>=0). Log OUT, type PAYMENT_REVERSAL.
 *        - bank/wallet → descuenta de la cuenta. Validación de fondos a nivel
 *          app (no hay CHECK>=0). FinancialMovement EXPENSE PAYMENT_REVERSAL.
 *   6. Soft-delete del pago (is_voided, voided_at, voided_by*, void_reason,
 *      void_uuid).
 *   7. Recompute settlement de la venta (crea/actualiza SaleCredit).
 *
 * `Customer.balance` NO se toca — paridad placepos (ver recompute helper).
 */
@Injectable()
export class DeleteSalePaymentAction {
  private readonly logger = new Logger(DeleteSalePaymentAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    saleId: number,
    paymentId: number,
    companyId: number,
    actor: DeleteSalePaymentActor,
    reason?: string | null,
    clientOperationId?: string | null,
  ): Promise<DeleteSalePaymentResult> {
    return this.dataSource.transaction<DeleteSalePaymentResult>('SERIALIZABLE', async (manager) => {
      // 1. Lock del pago.
      const payment = await manager.findOne(SalePayment, {
        where: {
          id: String(paymentId),
          sale_invoice_id: String(saleId),
          company_id: String(companyId),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        throw new NotFoundException('Pago no encontrado');
      }

      // 2. Fast-path idempotente: ya reversado.
      if (payment.is_voided) {
        return this.buildReplayResult(manager, payment, companyId);
      }

      // 3. Lock de la venta (SALE no anulada).
      const sale = await loadSaleForSettlement(manager, saleId, companyId);

      // 4. Lock del SaleCredit (si existe).
      const credit = await manager.findOne(SaleCredit, {
        where: { sale_invoice_id: sale.id, company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });

      // 5. Reverso del neto a la cuenta original.
      const netBig = toBig(payment.amount).minus(toBig(payment.change_amount ?? 0));
      if (netBig.lte(0)) {
        // Pago sin dinero neto (todo fue vuelto). Solo soft-delete + recompute.
        this.logger.warn({
          event: 'sale_payment.reverse.zero_net',
          companyId,
          saleId,
          paymentId,
        });
      }

      const voidUuid = this.deriveVoidUuid(clientOperationId);
      const reversedAmount = preciseNumber(netBig.lte(0) ? toBig(0) : netBig, 2);
      const folio = sale.sale_number ?? sale.ticket_number;

      if (netBig.gt(0)) {
        await this.reverseToOriginalAccount(manager, companyId, actor, payment, netBig, {
          folio,
          voidUuid,
        });
      }

      // 6. Soft-delete del pago.
      await manager.update(
        SalePayment,
        { id: payment.id, company_id: String(companyId) },
        {
          is_voided: true,
          voided_at: new Date(),
          voided_by: actor.fullName,
          voided_by_id: String(actor.id),
          void_reason: reason?.trim() || null,
          void_uuid: voidUuid,
        },
      );

      // 7. Recompute settlement.
      const settlement = await recomputeSaleSettlement(manager, sale, companyId, credit);

      this.logger.log({
        event: 'sale_payment.reversed',
        companyId,
        saleId,
        paymentId,
        reversedAmount,
        accountType: payment.account_type,
        accountId: Number(payment.account_id),
        salePaid: settlement.paid,
        saleBalance: settlement.balance,
        creditStatus: settlement.status,
        actorId: actor.id,
      });

      return {
        success: true,
        message: 'Pago reversado exitosamente',
        payment_id: Number(payment.id),
        reversed_amount: reversedAmount,
        sale_balance: settlement.balance,
        credit_status: this.toStatusLabel(settlement.status),
      };
    });
  }

  /**
   * Deriva la llave idempotente del reverso. `${client_operation_id}:void` si
   * el cliente envió la llave; uuid aleatorio en caso contrario.
   */
  private deriveVoidUuid(clientOperationId?: string | null): string {
    return clientOperationId ? `${clientOperationId}:void` : randomUUID();
  }

  /**
   * Descuenta el neto de la cuenta ORIGINAL del pago. Ramifica por account_type.
   */
  private async reverseToOriginalAccount(
    manager: EntityManager,
    companyId: number,
    actor: DeleteSalePaymentActor,
    payment: SalePayment,
    netBig: Big,
    ctx: { folio: string; voidUuid: string },
  ): Promise<void> {
    if (payment.account_type === 'cash_register') {
      await this.reverseCash(manager, companyId, actor, payment, netBig, ctx);
      return;
    }
    // bank / wallet.
    await this.reverseAccount(manager, companyId, actor, payment, netBig, ctx);
  }

  /**
   * Reverso CASH: descuenta de la caja ORIGINAL (account_id, puede ser de otro
   * usuario) + log OUT PAYMENT_REVERSAL. Validación de fondos ANTES del UPDATE
   * (CHECK balance >= 0).
   */
  private async reverseCash(
    manager: EntityManager,
    companyId: number,
    actor: DeleteSalePaymentActor,
    payment: SalePayment,
    netBig: Big,
    ctx: { folio: string; voidUuid: string },
  ): Promise<void> {
    const register = await manager.findOne(CashRegister, {
      where: { id: String(payment.account_id), company_id: String(companyId) },
      lock: { mode: 'pessimistic_write' },
    });
    if (!register) {
      throw new UnprocessableEntityException({
        message: 'La caja original del pago ya no existe; no se puede reversar el efectivo.',
        payload: { code: 'CASH_REGISTER_NOT_FOUND' },
      });
    }
    const newBalance = toBig(register.balance).minus(netBig);
    if (newBalance.lt(0)) {
      throw new UnprocessableEntityException({
        message:
          'El saldo de la caja no alcanza para reversar el pago en efectivo. Reconcilia manualmente.',
        payload: {
          code: 'INSUFFICIENT_REGISTER_BALANCE',
          required: preciseNumber(netBig, 2),
          available: Number(register.balance),
        },
      });
    }
    await manager.update(
      CashRegister,
      { id: register.id, company_id: String(companyId) },
      { balance: preciseNumber(newBalance, 2) },
    );
    const log = manager.create(CashRegisterLog, {
      company_id: String(companyId),
      cash_register_id: register.id,
      type: CashRegisterLogType.PAYMENT_REVERSAL,
      direction: 'OUT',
      amount: preciseNumber(netBig, 2),
      affects_balance: true,
      description: `Reverso de pago en efectivo - Venta #${ctx.folio}`,
      invoice_id: payment.sale_invoice_id,
      payment_id: payment.id,
      credit_note_id: null,
      is_credit_related: false,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    });
    await manager.save(CashRegisterLog, log);
  }

  /**
   * Reverso bank/wallet: descuenta de la cuenta + FinancialMovement EXPENSE
   * PAYMENT_REVERSAL. Validación de fondos a nivel app (no hay CHECK >= 0).
   *
   * Ramas explícitas bank/wallet (en vez de una variable de clase) para que
   * `manager.update` reciba un tipo de entidad concreto — paridad con
   * `void-sale.action.ts`.
   */
  private async reverseAccount(
    manager: EntityManager,
    companyId: number,
    actor: DeleteSalePaymentActor,
    payment: SalePayment,
    netBig: Big,
    ctx: { folio: string; voidUuid: string },
  ): Promise<void> {
    const accountId = Number(payment.account_id);
    let balanceBig: Big;

    if (payment.account_type === 'bank') {
      const bank = await manager.findOne(Bank, {
        where: { id: String(accountId), company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!bank) {
        throw new UnprocessableEntityException({
          message: 'La cuenta bancaria original del pago ya no existe; no se puede reversar.',
          payload: { code: 'BANK_NOT_FOUND' },
        });
      }
      balanceBig = this.assertSufficient(toBig(bank.balance), netBig);
      await manager.update(
        Bank,
        { id: bank.id, company_id: String(companyId) },
        { balance: preciseNumber(balanceBig, 2) },
      );
    } else {
      // wallet
      const wallet = await manager.findOne(Wallet, {
        where: { id: String(accountId), company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new UnprocessableEntityException({
          message: 'La billetera original del pago ya no existe; no se puede reversar.',
          payload: { code: 'WALLET_NOT_FOUND' },
        });
      }
      balanceBig = this.assertSufficient(toBig(wallet.balance), netBig);
      await manager.update(
        Wallet,
        { id: wallet.id, company_id: String(companyId) },
        { balance: preciseNumber(balanceBig, 2) },
      );
    }

    const sourceRef: AccountReference = payment.account_type === 'bank' ? 'bank' : 'wallet';
    await this.financialMovementsService.record(manager, {
      companyId,
      amount: preciseNumber(netBig, 2),
      movement_type: MovementType.EXPENSE,
      concept: MovementConcept.PAYMENT_REVERSAL,
      description: `Reverso de pago - Venta ${ctx.folio}`,
      source_type: sourceRef,
      source_id: accountId,
      destination_type: null,
      destination_id: null,
      reference_code: ctx.voidUuid,
      created_by: actor.fullName,
      created_by_id: actor.id,
    });
  }

  /**
   * Devuelve el nuevo balance (Big) tras restar `netBig`, o lanza 422
   * INSUFFICIENT_BALANCE si quedaría negativo. Validación a nivel app porque
   * bank/wallet NO tienen CHECK balance >= 0 en DB.
   */
  private assertSufficient(currentBig: Big, netBig: Big): Big {
    const newBalance = currentBig.minus(netBig);
    if (newBalance.lt(0)) {
      throw new UnprocessableEntityException({
        message: 'El saldo de la cuenta no alcanza para reversar el pago. Reconcilia manualmente.',
        payload: {
          code: 'INSUFFICIENT_BALANCE',
          required: preciseNumber(netBig, 2),
          available: preciseNumber(currentBig, 2),
        },
      });
    }
    return newBalance;
  }

  /**
   * Reconstruye el resultado para un reverso YA aplicado (replay idempotente).
   * Re-lee el settlement actual de la venta sin mutar nada.
   */
  private async buildReplayResult(
    manager: EntityManager,
    payment: SalePayment,
    companyId: number,
  ): Promise<DeleteSalePaymentResult> {
    const credit = await manager.findOne(SaleCredit, {
      where: { sale_invoice_id: payment.sale_invoice_id, company_id: String(companyId) },
    });
    const netBig = toBig(payment.amount).minus(toBig(payment.change_amount ?? 0));
    const balance = credit ? Number(credit.balance) : 0;
    const status: SaleCreditStatus = credit ? credit.status : SaleCreditStatus.PAID;
    return {
      success: true,
      message: 'Pago ya reversado (reintento idempotente)',
      payment_id: Number(payment.id),
      reversed_amount: preciseNumber(netBig.lte(0) ? toBig(0) : netBig, 2),
      sale_balance: balance,
      credit_status: this.toStatusLabel(status),
      replay: true,
    };
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
