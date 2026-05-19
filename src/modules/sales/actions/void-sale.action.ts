import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { toBig } from '@/common/utils/precision';
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
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import { SalePayment, SalePaymentMethod } from '../entities/sale-payment.entity';
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
  ) {}

  async execute(
    id: number,
    companyId: number,
    actor: VoidSaleActor,
    reason?: string | null,
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

      return this.voidSale(manager, sale, companyId, actor, reason);
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

    // Paridad PlacePos: solo se busca el pago CASH para reversar. Los pagos
    // TRANSFER NO generan reversa automática aquí — si existen, la
    // conciliación del banco se hace manualmente o vía PUT /sales/:id con
    // correction_source explícito.
    const cashPayment = await manager.findOne(SalePayment, {
      where: {
        sale_invoice_id: sale.id,
        company_id: String(companyId),
        payment_method: SalePaymentMethod.CASH,
      },
      select: { id: true, amount: true },
    });

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
    );

    await manager.update(
      SaleInvoice,
      { id: sale.id, company_id: String(companyId) },
      { is_deleted: true },
    );

    // Reversa CASH si hubo pago en efectivo y monto > 0 (paridad PlacePos
    // `registerCreditNoteFullVoid`).
    if (cashPayment && toBig(cashPayment.amount).gt(0)) {
      await this.reverseCashPayment(
        manager,
        companyId,
        actor,
        Number(sale.id),
        Number(savedNote.id),
        Number(cashPayment.amount),
      );
    }

    this.logger.log({
      event: 'sale.voided.sale',
      companyId,
      saleId: Number(sale.id),
      creditNoteId: Number(savedNote.id),
      creditNoteNumber: savedNote.note_number,
      cashRefunded: cashPayment ? Number(cashPayment.amount) : 0,
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
}
