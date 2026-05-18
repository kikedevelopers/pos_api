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
 * Actor que ejecuta la anulación (owner/manager). Se persiste como
 * `created_by`/`created_by_id` en la NC y en el log de caja.
 */
export interface VoidSaleActor {
  id: number;
  fullName: string;
  type: string | null;
}

/**
 * Anula una venta. Espejo PlacePos `voidTicket`:
 *   - `ORDER` → soft-delete directo (sin NC, sin stock, sin caja).
 *   - `SALE`  → genera NC `FULL_VOID`, devuelve stock, reversa CASH si aplica.
 *
 * --------------------------------------------------------------------------
 * Pasos para SALE (una transacción)
 * --------------------------------------------------------------------------
 *
 *   0. Lock pessimistic_write sobre la venta. Validar `is_deleted=false`.
 *   1. Idempotencia: si ya existe NC `FULL_VOID` activa para la venta → 422
 *      `ALREADY_FULL_VOIDED`.
 *   2. Folio CN per-company (atómico).
 *   3. INSERT CreditNote + lines snapshot.
 *   4. `adjustInventory(... 'RETURN')` (stub mientras Product.stock no exista).
 *   5. UPDATE `SaleInvoice.is_deleted=true`.
 *   6. Reversa de pagos CASH: por CADA SalePayment con payment_method=CASH:
 *      - getOrCreateCashRegisterForUser (caja del actor).
 *      - 422 INSUFFICIENT_REGISTER_BALANCE si balance < amount.
 *      - INSERT CashRegisterLog CREDIT_NOTE_FULL_VOID (OUT, affects=true).
 *      - UPDATE register.balance -= amount.
 *   7. Pagos TRANSFER: requieren correction_source — caso edge, se marca como
 *      pendiente (422 MISSING_CORRECTION_SOURCE). PlacePos local tampoco
 *      reversa transfers automáticamente en voidSale, así que mantenemos
 *      paridad.
 *
 * --------------------------------------------------------------------------
 * Roles
 * --------------------------------------------------------------------------
 *
 * `@Roles('owner', 'manager')` se aplica en el controller. El service
 * recibe `actor.type` solo para auditoría (no enforcement).
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
  ): Promise<{ creditNoteId: number | null; creditNoteNumber: string | null }> {
    // SERIALIZABLE: CLAUDE.md §9.4 — generación de NC/ND es flujo crítico
    // (lectura idempotency de FULL_VOID + mutación de stock/caja en paralelo).
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const sale = await findSaleInCompany(manager, id, companyId, {
        requireActive: false,
        lock: true,
      });

      if (sale.is_deleted) {
        throw new UnprocessableEntityException({
          message: 'Esta venta ya fue anulada anteriormente',
          payload: { code: 'INVALID_TICKET_STATE' },
        });
      }

      // ---------- ORDER: soft-delete directo ----------
      if (sale.ticket_type === TicketType.ORDER) {
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
        return { creditNoteId: null, creditNoteNumber: null };
      }

      // ---------- SALE: genera NC FULL_VOID ----------
      // Idempotencia: una sola FULL_VOID activa por venta.
      const existingFullVoid = await manager.findOne(CreditNote, {
        where: {
          company_id: String(companyId),
          sale_invoice_id: sale.id,
          operation_type: OperationType.FULL_VOID,
          is_deleted: false,
        },
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

      const payments = await manager.find(SalePayment, {
        where: { sale_invoice_id: sale.id, company_id: String(companyId) },
      });
      const cashPayments = payments.filter((p) => p.payment_method === SalePaymentMethod.CASH);
      const transferPayments = payments.filter(
        (p) => p.payment_method === SalePaymentMethod.TRANSFER,
      );

      // Defensa: si hay TRANSFER, requerimos correction_source explícito.
      // PlacePos local no maneja este caso automáticamente; lo bloqueamos en
      // pos_api para evitar des-cuadre silencioso del banco.
      // TODO: aceptar un payload `transfer_correction_source` para reversar
      //       atómicamente el banco con FinancialMovement EXPENSE ADJUSTMENT.
      if (transferPayments.length > 0) {
        throw new UnprocessableEntityException({
          message:
            'La venta tiene pagos por transferencia. Usa PUT /sales/:id para reversar con correction_source explícito.',
          payload: {
            code: 'MISSING_CORRECTION_SOURCE',
            transferPayments: transferPayments.map((p) => ({
              id: Number(p.id),
              amount: Number(p.amount),
              bank_id: p.bank_id ? Number(p.bank_id) : null,
            })),
          },
        });
      }

      // Folio CN.
      const cnTicket = await this.incrementTicketNumberAction.execute(
        manager,
        companyId,
        TicketSettingType.CREDIT_NOTE,
      );

      // INSERT CreditNote.
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

      // INSERT CreditNoteLine (snapshot).
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

      // Stock: devolver al inventario.
      await adjustInventory(
        manager,
        companyId,
        lines.map((l) => ({
          item_id: Number(l.product_id),
          quantity: Number(l.quantity),
        })),
        'RETURN',
      );

      // UPDATE invoice.is_deleted = true.
      await manager.update(
        SaleInvoice,
        { id: sale.id, company_id: String(companyId) },
        { is_deleted: true },
      );

      // Reversa CASH: por cada pago en efectivo, descontar de la caja del
      // actor y registrar log CREDIT_NOTE_FULL_VOID.
      for (const cashPayment of cashPayments) {
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
        cashRefunded: cashPayments.reduce((s, p) => s + Number(p.amount), 0),
        actorId: actor.id,
      });

      return {
        creditNoteId: Number(savedNote.id),
        creditNoteNumber: savedNote.note_number,
      };
    });
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
      description: `Devolución por anulación total - Venta #${invoiceId}`,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
      is_credit_related: false,
    });
    await manager.save(CashRegisterLog, log);
  }
}
