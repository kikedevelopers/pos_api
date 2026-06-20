import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';
import {
  CreditNote,
  NoteType,
  OperationType,
} from '@/modules/credit-notes/entities/credit-note.entity';
import {
  AccountReference,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { SaleCorrectionSourceDto } from '../dto/update-sale.dto';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import { SalePayment, SalePaymentMethod } from '../entities/sale-payment.entity';
import { recomputeSalePoints } from '../internal/customer-points.helper';
import { findSaleInCompany } from '../internal/sale-lookups';

/**
 * Resultado del action — shape PlacePos `voidTicket`.
 */
export interface VoidSaleActionResult {
  message: string;
  creditNoteId: number | null;
  creditNoteNumber: string | null;
}

/**
 * Actor que ejecuta la anulación. Se persiste como `created_by`/`created_by_id`
 * en la NC y en el log de caja, y se usa para resolver la caja receptora
 * del reembolso CASH.
 */
export interface VoidSaleActor {
  id: number;
  fullName: string;
  type: string | null;
}

/**
 * Anula una venta. Espejo PlacePos `voidTicket`:
 *
 *   - `ORDER` → soft-delete directo (sin NC, sin stock, sin caja).
 *   - `SALE`  → genera NC `FULL_VOID`, devuelve stock, reversa CASH si aplica.
 *     Los pagos TRANSFER se IGNORAN intencionalmente — paridad PlacePos:
 *     `voidSale` local solo busca pagos CASH (`payment_method = 'CASH'`).
 *     Si hubo cobro por transferencia, la reversa del banco se gestiona
 *     manualmente o por `PUT /sales/:id` con `credit_correction_source`.
 *
 * Multi-tenant: el `companyId` se filtra en TODOS los lookups. Transacción
 * SERIALIZABLE para evitar carreras en idempotencia (FULL_VOID) y mutación
 * concurrente de la caja registradora.
 */
@Injectable()
export class VoidSaleAction {
  private readonly logger = new Logger(VoidSaleAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly incrementTicketNumberAction: IncrementTicketNumberAction,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    id: number,
    companyId: number,
    actor: VoidSaleActor,
    reason?: string | null,
    refundSource?: SaleCorrectionSourceDto | null,
  ): Promise<VoidSaleActionResult> {
    return this.dataSource.transaction<VoidSaleActionResult>('SERIALIZABLE', async (manager) => {
      const sale = await findSaleInCompany(manager, id, companyId, {
        requireActive: false,
        lock: true,
      });

      if (sale.is_deleted) {
        throw new UnprocessableEntityException({
          message:
            sale.ticket_type === TicketType.ORDER
              ? 'Este pedido ya fue anulado anteriormente'
              : 'Esta venta ya fue anulada anteriormente',
          payload: { code: 'INVALID_TICKET_STATE' },
        });
      }

      if (sale.ticket_type === TicketType.ORDER) {
        return this.voidOrder(manager, sale, companyId, actor);
      }

      return this.voidSale(manager, sale, companyId, actor, reason, refundSource ?? null);
    });
  }

  // --------------------------------------------------------------------------
  // ORDER: soft-delete directo
  // --------------------------------------------------------------------------

  private async voidOrder(
    manager: EntityManager,
    sale: SaleInvoice,
    companyId: number,
    actor: VoidSaleActor,
  ): Promise<VoidSaleActionResult> {
    await manager.update(
      SaleInvoice,
      { id: sale.id, company_id: String(companyId) },
      { is_deleted: true },
    );
    this.logger.log({
      event: 'sale.voided.order',
      companyId,
      saleId: Number(sale.id),
      actorId: actor.id,
    });
    return {
      message: 'Pedido anulado exitosamente',
      creditNoteId: null,
      creditNoteNumber: null,
    };
  }

  // --------------------------------------------------------------------------
  // SALE: NC FULL_VOID + reversa CASH
  // --------------------------------------------------------------------------

  private async voidSale(
    manager: EntityManager,
    sale: SaleInvoice,
    companyId: number,
    actor: VoidSaleActor,
    reason?: string | null,
    refundSource?: SaleCorrectionSourceDto | null,
  ): Promise<VoidSaleActionResult> {
    // Idempotencia: una sola FULL_VOID activa por venta.
    const existingFullVoid = await manager.findOne(CreditNote, {
      where: {
        company_id: String(companyId),
        sale_invoice_id: sale.id,
        operation_type: OperationType.FULL_VOID,
        is_deleted: false,
      },
      select: { id: true },
    });
    if (existingFullVoid) {
      throw new UnprocessableEntityException({
        message: 'Esta venta ya tiene una nota crédito de anulación total',
        payload: { code: 'ALREADY_FULL_VOIDED' },
      });
    }

    const lines = await manager.find(SaleInvoiceLine, {
      where: { sale_invoice_id: sale.id, company_id: String(companyId) },
      order: { id: 'ASC' },
    });

    // I-7: TODOS los pagos de la venta deben generar reversa, no solo CASH.
    //  - CASH  → CashRegisterLog(CREDIT_NOTE_FULL_VOID, OUT) en la caja del
    //            actor que anula (paridad PlacePos).
    //  - TRANSFER → FinancialMovement(EXPENSE, CREDIT_NOTE_REFUND) desde la
    //            cuenta bank/wallet indicada en `refund_source`.
    // Si hay pagos TRANSFER y no llega `refund_source` → 422.
    // Excluimos pagos YA reversados (is_voided): su dinero ya fue devuelto a la
    // cuenta original por `delete-sale-payment.action`, reversarlos otra vez
    // descuadraría la caja/banco (feature "eliminar/reversar un pago").
    const allPayments = await manager.find(SalePayment, {
      where: {
        sale_invoice_id: sale.id,
        company_id: String(companyId),
        is_voided: false,
      },
      order: { created_at: 'ASC' },
    });
    const transferPayments = allPayments.filter(
      (p) => p.payment_method === SalePaymentMethod.TRANSFER,
    );
    const cashPayments = allPayments.filter((p) => p.payment_method === SalePaymentMethod.CASH);

    if (
      transferPayments.length > 0 &&
      transferPayments.some((p) => toBig(p.amount).gt(0)) &&
      !refundSource
    ) {
      throw new UnprocessableEntityException({
        message:
          'La venta tiene cobros por transferencia. Indica refund_source para reembolsar la NC.',
        payload: { code: 'MISSING_REFUND_SOURCE' },
      });
    }

    // Folio CN.
    const cnTicket = await this.incrementTicketNumberAction.execute(
      manager,
      companyId,
      TicketSettingType.CREDIT_NOTE,
    );

    const creditNote = manager.create(CreditNote, {
      company_id: String(companyId),
      sale_invoice_id: sale.id,
      customer_id: sale.customer_id,
      note_number: cnTicket.formatted,
      note_type: NoteType.CREDIT,
      operation_type: OperationType.FULL_VOID,
      subtotal: sale.subtotal,
      tax_total: sale.tax_total,
      total: sale.total,
      reason: reason?.trim() || 'Anulación total de venta',
      created_by: actor.fullName,
      created_by_id: String(actor.id),
      is_deleted: false,
    });
    const savedNote = await manager.save(CreditNote, creditNote);

    if (lines.length > 0) {
      const noteLines = lines.map((l) => ({
        company_id: String(companyId),
        credit_note_id: savedNote.id,
        original_line_id: l.id,
        product_id: l.product_id,
        packaging_id: l.packaging_id,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price,
        unit_cost: l.unit_cost,
        subtotal: l.subtotal,
        iva_percentage: l.iva_percentage,
        iva_amount: l.iva_amount,
        total: l.total,
      }));
      await manager.insert(CreditNoteLine, noteLines);
    }

    await adjustInventory(
      manager,
      companyId,
      lines.map((l) => ({
        item_id: Number(l.product_id),
        quantity: Number(l.quantity),
      })),
      'RETURN',
      {
        reason: 'SALE_VOID',
        referenceType: 'credit_note',
        referenceId: Number(savedNote.id),
        referenceCode: savedNote.note_number,
        description: `Anulación total de venta — ${savedNote.note_number}`,
        actorName: actor.fullName,
        actorUserId: actor.id,
        // La venta pudo incluir productos COMPARTIDOS del principal (company_id
        // distinto de la sucursal): la devolución de stock debe resolver por el
        // set accesible y reponer en el dueño REAL. Sin esto, anular una venta
        // con productos compartidos no repone el stock del principal.
        crossCompanyAccess: true,
      },
    );

    await manager.update(
      SaleInvoice,
      { id: sale.id, company_id: String(companyId) },
      { is_deleted: true },
    );

    // PUNTOS: tras emitir la NC FULL_VOID, el total consolidado queda en 0
    // (total − total). El recompute idempotente lleva los puntos otorgados a 0
    // y revierte el saldo del cliente por el delta negativo. La venta sigue
    // siendo ticket_type=SALE (el helper no bailar por is_deleted). Misma TX
    // SERIALIZABLE.
    await recomputeSalePoints(manager, Number(sale.id), companyId);

    // Reversa CASH: por cada pago CASH (puede haber más de uno) descuento
    // de la caja del actor + log CREDIT_NOTE_FULL_VOID. Paridad PlacePos
    // `registerCreditNoteFullVoid`.
    let cashRefunded = new Big(0);
    for (const cashPayment of cashPayments) {
      // Reembolsamos el NETO que entró a caja al cobrar (amount − change), NO
      // el bruto entregado por el cliente. Si hubo sobrepago (change>0), la
      // caja subió sólo por el neto; descontar el bruto la dejaría negativa.
      const amt = toBig(cashPayment.amount).minus(toBig(cashPayment.change_amount));
      if (amt.lte(0)) {
        continue;
      }
      await this.reverseCashPayment(
        manager,
        companyId,
        actor,
        Number(sale.id),
        Number(savedNote.id),
        preciseNumber(amt, 2),
      );
      cashRefunded = cashRefunded.plus(amt);
    }

    // Reversa TRANSFER: por cada pago TRANSFER, registramos un
    // FinancialMovement(EXPENSE, CREDIT_NOTE_REFUND) que descuenta el saldo
    // del bank/wallet destino. Un movimiento por pago original — así el
    // rastro contable coincide con los INCOMEs generados al cobrar.
    let transferRefunded = new Big(0);
    if (transferPayments.length > 0 && refundSource) {
      const target = await this.resolveRefundTarget(manager, companyId, refundSource);
      for (const transfer of transferPayments) {
        // Reversamos el mismo NETO que se acreditó al cobrar. En TRANSFER el
        // vuelto siempre es 0, así que el neto iguala `amount`; restamos
        // `change_amount` por defensa para no divergir si un dato legado lo
        // trajera distinto de 0.
        const amt = toBig(transfer.amount).minus(toBig(transfer.change_amount));
        if (amt.lte(0)) {
          continue;
        }
        await this.reverseTransferPayment(manager, companyId, actor, {
          target,
          amount: amt,
          noteNumber: savedNote.note_number,
          invoiceId: Number(sale.id),
          paymentId: Number(transfer.id),
        });
        transferRefunded = transferRefunded.plus(amt);
      }
    }

    this.logger.log({
      event: 'sale.voided.sale',
      companyId,
      saleId: Number(sale.id),
      creditNoteId: Number(savedNote.id),
      creditNoteNumber: savedNote.note_number,
      cashRefunded: preciseNumber(cashRefunded, 2),
      transferRefunded: preciseNumber(transferRefunded, 2),
      refundSourceType: refundSource?.type ?? null,
      refundSourceId: refundSource?.id ?? null,
      actorId: actor.id,
    });

    return {
      message: 'Venta anulada exitosamente. Se generó nota crédito.',
      creditNoteId: Number(savedNote.id),
      creditNoteNumber: savedNote.note_number,
    };
  }

  /**
   * Descuenta `amount` de la caja del actor + log `CREDIT_NOTE_FULL_VOID`.
   * Lanza 422 INSUFFICIENT_REGISTER_BALANCE si el saldo no alcanza (edge:
   * el cobrador ya gastó el dinero antes de la anulación).
   */
  private async reverseCashPayment(
    manager: EntityManager,
    companyId: number,
    actor: VoidSaleActor,
    invoiceId: number,
    creditNoteId: number,
    amount: number,
  ): Promise<void> {
    const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
    const newBalance = toBig(register.balance).minus(amount);
    if (newBalance.lt(0)) {
      throw new UnprocessableEntityException({
        message:
          'El saldo de la caja no alcanza para reversar el pago en efectivo. Anula manualmente.',
        payload: {
          code: 'INSUFFICIENT_REGISTER_BALANCE',
          required: amount,
          available: Number(register.balance),
        },
      });
    }
    await manager.update(
      CashRegister,
      { id: register.id, company_id: String(companyId) },
      { balance: Number(newBalance.toFixed(2)) },
    );
    const log = manager.create(CashRegisterLog, {
      company_id: String(companyId),
      cash_register_id: register.id,
      type: CashRegisterLogType.CREDIT_NOTE_FULL_VOID,
      direction: 'OUT',
      amount,
      affects_balance: true,
      invoice_id: String(invoiceId),
      credit_note_id: String(creditNoteId),
      description: `Devolución por anulación total — Venta #${invoiceId}`,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
      is_credit_related: false,
    });
    await manager.save(CashRegisterLog, log);
  }

  /**
   * Resuelve y lockea la cuenta destino del reembolso TRANSFER. Solo
   * acepta bank/wallet — `cash_register` se rechaza con 422 porque
   * conceptualmente un cobro TRANSFER no puede reembolsarse a efectivo
   * sin un retiro físico (PlacePos no lo soporta tampoco).
   */
  private async resolveRefundTarget(
    manager: EntityManager,
    companyId: number,
    source: SaleCorrectionSourceDto,
  ): Promise<{ type: 'bank' | 'wallet'; id: number; balance: Big }> {
    if (source.type === 'cash_register') {
      throw new UnprocessableEntityException({
        message:
          'No se puede reembolsar una venta TRANSFER a una caja de efectivo. Selecciona un banco o billetera.',
        payload: { code: 'INVALID_REFUND_DESTINATION' },
      });
    }
    if (source.type === 'wallet') {
      const wallet = await manager.findOne(Wallet, {
        where: {
          id: String(source.id),
          company_id: String(companyId),
          is_archived: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Billetera destino no encontrada');
      }
      return { type: 'wallet', id: Number(wallet.id), balance: toBig(wallet.balance) };
    }
    const bank = await manager.findOne(Bank, {
      where: {
        id: String(source.id),
        company_id: String(companyId),
        is_archived: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bank) {
      throw new NotFoundException('Banco destino no encontrado');
    }
    return { type: 'bank', id: Number(bank.id), balance: toBig(bank.balance) };
  }

  /**
   * Descuenta `amount` de la cuenta bank/wallet destino + emite
   * FinancialMovement(EXPENSE, CREDIT_NOTE_REFUND). Lanza 422
   * INSUFFICIENT_BALANCE si la cuenta no tiene saldo suficiente.
   */
  private async reverseTransferPayment(
    manager: EntityManager,
    companyId: number,
    actor: VoidSaleActor,
    params: {
      target: { type: 'bank' | 'wallet'; id: number; balance: Big };
      amount: Big;
      noteNumber: string;
      invoiceId: number;
      paymentId: number;
    },
  ): Promise<void> {
    const newBalance = params.target.balance.minus(params.amount);
    if (newBalance.lt(0)) {
      throw new UnprocessableEntityException({
        message:
          'El saldo de la cuenta no alcanza para reversar el cobro por transferencia. Selecciona otra cuenta o reconcilia manualmente.',
        payload: {
          code: 'INSUFFICIENT_BALANCE',
          required: preciseNumber(params.amount, 2),
          available: preciseNumber(params.target.balance, 2),
        },
      });
    }
    const newBalanceNum = preciseNumber(newBalance, 2);
    if (params.target.type === 'wallet') {
      await manager.update(
        Wallet,
        { id: String(params.target.id), company_id: String(companyId) },
        { balance: newBalanceNum },
      );
    } else {
      await manager.update(
        Bank,
        { id: String(params.target.id), company_id: String(companyId) },
        { balance: newBalanceNum },
      );
    }
    params.target.balance = newBalance;

    const destinationAccountRef: AccountReference = params.target.type;
    await this.financialMovementsService.record(manager, {
      companyId,
      amount: preciseNumber(params.amount, 2),
      movement_type: MovementType.EXPENSE,
      concept: MovementConcept.CREDIT_NOTE_REFUND,
      description: `Reembolso por anulación de venta — NC ${params.noteNumber} (venta #${params.invoiceId})`,
      source_type: destinationAccountRef,
      source_id: params.target.id,
      destination_type: null,
      destination_id: null,
      reference_code: `SALE-VOID-${params.noteNumber}-PAY-${params.paymentId}`,
      created_by: actor.fullName,
      created_by_id: actor.id,
    });
  }
}
