import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';
import {
  CreditNote,
  NoteType,
  OperationType,
} from '@/modules/credit-notes/entities/credit-note.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import { SaleCorrectionSourceDto, UpdateSaleDto, UpdateSaleLineDto } from '../dto/update-sale.dto';
import { SaleCredit } from '../entities/sale-credit.entity';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import {
  getConsolidatedInvoice,
  type ConsolidatedInvoice,
  type ConsolidatedLine,
} from '../internal/consolidate-invoice.helper';
import { translateSaleConstraintError } from '../internal/constraint-errors';
import { assertMarginAboveMinimum } from '../internal/margin-guard.helper';
import { findSaleInCompany } from '../internal/sale-lookups';

/**
 * Resultado del action — shape PlacePos `editTicket`.
 */
export interface UpdateSaleActionResult {
  message: string;
  creditNoteId: number | null;
  creditNoteNumber: string | null;
  debitNoteId: number | null;
  debitNoteNumber: string | null;
}

/**
 * Actor que ejecuta la edición (User u Employee). Se persiste como
 * `created_by` en cualquier NC/ND emitida y se usa para evaluar overrides
 * de margen mínimo.
 */
export interface UpdateSaleActor {
  id: number;
  fullName: string;
  type: string | null;
}

interface PlacePosLineDifference {
  type: 'removed' | 'added' | 'reduced' | 'increased';
  item_id: number;
  name: string;
  cost: number;
  price: number;
  quantity: number;
  total: number;
}

/**
 * Edita una venta. Espejo byte-por-byte del `editTicket` (`editOrder` +
 * `editSale`) de PlacePos local. Multi-tenant: el `companyId` se inyecta
 * desde el JWT — nunca del payload.
 *
 * --------------------------------------------------------------------------
 * Flujo según `ticket_type`
 * --------------------------------------------------------------------------
 *
 *   - `ORDER`: reemplazo total (DELETE + INSERT lines, UPDATE cabecera).
 *     Sin NC/ND, sin inventario, sin caja.
 *   - `SALE`:
 *       * Sin delta de líneas:
 *         - Si no cambia el cliente → no-op.
 *         - Si cambia el cliente → UPDATE `customer_*` (guard SaleCredit).
 *       * Con delta:
 *         - NC `PARTIAL_VOID` (o `FULL_VOID` si la edición remueve toda la
 *           venta) por líneas removidas / reducidas.
 *         - ND `ADDITION` por líneas añadidas / incrementadas.
 *         - Si la edición incluye ND → guard de margen consolidado.
 *         - Inventario diferencial (RETURN para NC, DEDUCT para ND).
 *         - Movimientos de caja / banco / wallet si vienen
 *           `credit_correction_source` / `debit_correction_source`.
 *
 * --------------------------------------------------------------------------
 * Transacción SERIALIZABLE
 * --------------------------------------------------------------------------
 *
 * SERIALIZABLE protege contra anomalías de lectura no repetible cuando se
 * evalúa el delta + balance del crédito mientras un cobro paralelo
 * (`POST /payments`) muta el SaleCredit. Espejo CLAUDE.md §9.4.
 */
@Injectable()
export class UpdateSaleAction {
  private readonly logger = new Logger(UpdateSaleAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly incrementTicketNumberAction: IncrementTicketNumberAction,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    id: number,
    dto: UpdateSaleDto,
    companyId: number,
    actor: UpdateSaleActor,
  ): Promise<UpdateSaleActionResult> {
    return this.dataSource.transaction<UpdateSaleActionResult>('SERIALIZABLE', async (manager) =>
      this.run(manager, id, dto, companyId, actor),
    );
  }

  private async run(
    manager: EntityManager,
    id: number,
    dto: UpdateSaleDto,
    companyId: number,
    actor: UpdateSaleActor,
  ): Promise<UpdateSaleActionResult> {
    if (dto.override_margin === true && actor.type !== 'owner' && actor.type !== 'superadmin') {
      throw new ForbiddenException({
        message: 'Solo el dueño puede forzar el override de margen mínimo.',
        payload: { code: 'OVERRIDE_NOT_ALLOWED' },
      });
    }

    const sale = await findSaleInCompany(manager, id, companyId, {
      requireActive: true,
      lock: true,
    });

    if (sale.ticket_type === TicketType.ORDER) {
      return this.editOrderFlow(manager, sale, dto, companyId, actor);
    }
    return this.editSaleFlow(manager, sale, dto, companyId, actor);
  }

  // --------------------------------------------------------------------------
  // ORDER flow — espejo PlacePos editOrder
  // --------------------------------------------------------------------------

  private async editOrderFlow(
    manager: EntityManager,
    sale: SaleInvoice,
    dto: UpdateSaleDto,
    companyId: number,
    actor: UpdateSaleActor,
  ): Promise<UpdateSaleActionResult> {
    if (!dto.items || dto.items.length === 0) {
      throw new UnprocessableEntityException(
        'Se requieren items para editar el pedido. Para anular usa POST /sales/:id/void.',
      );
    }
    if (
      dto.total === undefined ||
      dto.cost === undefined ||
      dto.profit === undefined ||
      dto.margin === undefined
    ) {
      throw new UnprocessableEntityException(
        'Los totales (total, cost, profit, margin) son obligatorios para editar un pedido.',
      );
    }

    const resolvedCustomer = await this.resolveCustomerForPayload(manager, dto, companyId);

    await manager.delete(SaleInvoiceLine, {
      sale_invoice_id: sale.id,
      company_id: String(companyId),
    });

    const lineRows = dto.items.map((item) => mapPayloadLineToRow(item, sale.id, companyId));
    await manager.insert(SaleInvoiceLine, lineRows);

    try {
      await manager.update(
        SaleInvoice,
        { id: sale.id, company_id: String(companyId) },
        {
          customer_id: resolvedCustomer.customerId,
          customer_name: resolvedCustomer.customerName,
          subtotal: dto.total,
          tax_total: 0,
          total: dto.total,
          cost: dto.cost,
          profit: dto.profit,
          margin: dto.margin,
        },
      );
    } catch (error) {
      translateSaleConstraintError(error);
      throw error;
    }

    this.logger.log({
      event: 'sale.updated.order',
      companyId,
      saleId: Number(sale.id),
      actorId: actor.id,
    });

    return {
      message: 'Pedido actualizado exitosamente',
      creditNoteId: null,
      creditNoteNumber: null,
      debitNoteId: null,
      debitNoteNumber: null,
    };
  }

  // --------------------------------------------------------------------------
  // SALE flow — espejo PlacePos editSale
  // --------------------------------------------------------------------------

  private async editSaleFlow(
    manager: EntityManager,
    sale: SaleInvoice,
    dto: UpdateSaleDto,
    companyId: number,
    actor: UpdateSaleActor,
  ): Promise<UpdateSaleActionResult> {
    const fullVoid = await manager.findOne(CreditNote, {
      where: {
        company_id: String(companyId),
        sale_invoice_id: sale.id,
        operation_type: OperationType.FULL_VOID,
        is_deleted: false,
      },
      select: { id: true },
    });
    if (fullVoid) {
      throw new UnprocessableEntityException({
        message: 'Esta venta tiene una anulación total activa y no se puede editar',
        payload: { code: 'SALE_FULL_VOIDED' },
      });
    }

    const consolidated = await getConsolidatedInvoice(manager, companyId, Number(sale.id));
    if (!consolidated) {
      throw new NotFoundException('Venta no encontrada');
    }

    const customerChanged = this.hasCustomerChanged(dto, consolidated);

    // Si no llegan líneas, solo se permite cambio de cliente.
    if (!dto.items) {
      if (!customerChanged) {
        return this.noChangesResult();
      }
      await this.applyCustomerChange(manager, sale, dto, companyId);
      return {
        message: 'Cliente de la venta actualizado',
        creditNoteId: null,
        creditNoteNumber: null,
        debitNoteId: null,
        debitNoteNumber: null,
      };
    }

    const { removedOrReduced, addedOrIncreased } = calculatePlacePosLineDifferences(
      consolidated.lines,
      dto.items,
    );

    if (removedOrReduced.length === 0 && addedOrIncreased.length === 0) {
      if (!customerChanged) {
        return this.noChangesResult();
      }
      await this.applyCustomerChange(manager, sale, dto, companyId);
      return {
        message: 'Cliente de la venta actualizado',
        creditNoteId: null,
        creditNoteNumber: null,
        debitNoteId: null,
        debitNoteNumber: null,
      };
    }

    // Guard de margen consolidado SOLO cuando la edición incluye ND
    // (productos añadidos / aumentados). Una NC pura siempre reduce el
    // margen — paridad PlacePos.
    if (addedOrIncreased.length > 0) {
      if (dto.total === undefined || dto.cost === undefined) {
        throw new UnprocessableEntityException(
          'Los totales consolidados (total, cost) son obligatorios cuando se añaden o incrementan líneas.',
        );
      }
      await assertMarginAboveMinimum({
        manager,
        companyId,
        total: dto.total,
        cost: dto.cost,
        overrideMargin: dto.override_margin === true,
        userType: actor.type,
        messagePrefix: 'El margen consolidado de la venta',
      });
    }

    const isFullVoidEdit =
      removedOrReduced.length === consolidated.lines.length &&
      addedOrIncreased.length === 0 &&
      removedOrReduced.every((r) => r.type === 'removed');

    let creditNoteId: number | null = null;
    let creditNoteNumber: string | null = null;
    let debitNoteId: number | null = null;
    let debitNoteNumber: string | null = null;

    if (removedOrReduced.length > 0) {
      const credit = await this.emitCreditNote(manager, {
        companyId,
        sale,
        customerId: this.currentCustomerId(sale),
        lines: removedOrReduced,
        isFullVoidEdit,
        actor,
        source: dto.credit_correction_source ?? null,
      });
      creditNoteId = credit.id;
      creditNoteNumber = credit.number;
    }

    if (addedOrIncreased.length > 0) {
      const debit = await this.emitDebitNote(manager, {
        companyId,
        sale,
        customerId: this.currentCustomerId(sale),
        lines: addedOrIncreased,
        actor,
        source: dto.debit_correction_source ?? null,
        // override_stock solo lo respeta el ajuste si el actor es owner/superadmin
        // — paridad PlacePos `editSale` (processDebitPart: allowOverride).
        overrideStock:
          dto.override_stock === true &&
          (actor.type === 'owner' || actor.type === 'superadmin'),
      });
      debitNoteId = debit.id;
      debitNoteNumber = debit.number;
    }

    if (customerChanged) {
      await this.applyCustomerChange(manager, sale, dto, companyId);
    }

    let message = 'Venta editada exitosamente.';
    if (creditNoteNumber) {
      message += ` Nota crédito: ${creditNoteNumber}.`;
    }
    if (debitNoteNumber) {
      message += ` Nota débito: ${debitNoteNumber}.`;
    }
    if (customerChanged) {
      message += ' Cliente actualizado.';
    }

    this.logger.log({
      event: 'sale.updated.sale',
      companyId,
      saleId: Number(sale.id),
      creditNoteId,
      creditNoteNumber,
      debitNoteId,
      debitNoteNumber,
      customerChanged,
      removed: removedOrReduced.length,
      added: addedOrIncreased.length,
      actorId: actor.id,
    });

    return {
      message,
      creditNoteId,
      creditNoteNumber,
      debitNoteId,
      debitNoteNumber,
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private noChangesResult(): UpdateSaleActionResult {
    return {
      message: 'No hay cambios que procesar',
      creditNoteId: null,
      creditNoteNumber: null,
      debitNoteId: null,
      debitNoteNumber: null,
    };
  }

  /**
   * Devuelve el customer_id actual del sale como number|null. Lo usamos al
   * fijar `credit_notes.customer_id` para snapshot histórico, antes de
   * aplicar un eventual cambio de cliente.
   */
  private currentCustomerId(sale: SaleInvoice): number | null {
    return sale.customer_id === null ? null : Number(sale.customer_id);
  }

  /**
   * Compara el customer del payload contra el de la venta consolidada SOLO
   * por id. `undefined` en el DTO se interpreta como "no tocar" (paridad
   * PlacePos `hasCustomerChanged`).
   */
  private hasCustomerChanged(dto: UpdateSaleDto, consolidated: ConsolidatedInvoice): boolean {
    if (dto.customer_id === undefined) {
      return false;
    }
    const current = consolidated.customerId ?? null;
    const next = dto.customer_id === null ? null : Number(dto.customer_id);
    return current !== next;
  }

  /**
   * Resuelve `customer_id`/`customer_name` para persistir. Multi-tenant +
   * filtro `is_archived = false`. Si el DTO trae `customer_name` lo respeta
   * como snapshot (paridad PlacePos: el name se guarda tal como llega del
   * cliente sin tocar el catálogo); si no, toma `customer.name`.
   */
  private async resolveCustomerForPayload(
    manager: EntityManager,
    dto: UpdateSaleDto,
    companyId: number,
  ): Promise<{ customerId: string | null; customerName: string | null }> {
    if (dto.customer_id === undefined || dto.customer_id === null) {
      return { customerId: null, customerName: dto.customer_name ?? null };
    }
    const customer = await manager.findOne(Customer, {
      where: {
        id: String(dto.customer_id),
        company_id: String(companyId),
        is_archived: false,
      },
      select: { id: true, name: true },
    });
    if (!customer) {
      throw new UnprocessableEntityException('Cliente no encontrado o archivado');
    }
    return {
      customerId: customer.id,
      customerName: dto.customer_name ?? customer.name,
    };
  }

  /**
   * Aplica UPDATE de customer_* con guards. Solo se invoca cuando ya se
   * determinó que el cliente cambia.
   */
  private async applyCustomerChange(
    manager: EntityManager,
    sale: SaleInvoice,
    dto: UpdateSaleDto,
    companyId: number,
  ): Promise<void> {
    await this.assertNoLockedCredit(manager, Number(sale.id), companyId);
    const resolved = await this.resolveCustomerForPayload(manager, dto, companyId);
    try {
      await manager.update(
        SaleInvoice,
        { id: sale.id, company_id: String(companyId) },
        {
          customer_id: resolved.customerId,
          customer_name: resolved.customerName,
        },
      );
    } catch (error) {
      translateSaleConstraintError(error);
      throw error;
    }
  }

  /**
   * Bloquea el cambio de cliente cuando la venta tiene `SaleCredit` con
   * `paid_amount > 0` — espejo PlacePos `assertNoLockedCredit`.
   */
  private async assertNoLockedCredit(
    manager: EntityManager,
    saleId: number,
    companyId: number,
  ): Promise<void> {
    const credit = await manager.findOne(SaleCredit, {
      where: { sale_invoice_id: String(saleId), company_id: String(companyId) },
      select: { id: true, paid_amount: true },
    });
    if (credit && toBig(credit.paid_amount).gt(0)) {
      throw new UnprocessableEntityException({
        message:
          'No se puede cambiar el cliente: la venta tiene abonos a crédito recibidos. ' +
          'Anula los abonos antes de reasignar el cliente.',
        payload: { code: 'SALE_CREDIT_HAS_PAYMENTS' },
      });
    }
  }

  /**
   * Crea NC (`PARTIAL_VOID` o `FULL_VOID` si la edición remueve toda la
   * venta) + CreditNoteLines, ajusta inventario `RETURN` y, si viene
   * `credit_correction_source`, registra el reembolso en caja o
   * `financial_movements`. Si es FULL_VOID, marca la venta como
   * `is_deleted = true`.
   */
  private async emitCreditNote(
    manager: EntityManager,
    params: {
      companyId: number;
      sale: SaleInvoice;
      customerId: number | null;
      lines: PlacePosLineDifference[];
      isFullVoidEdit: boolean;
      actor: UpdateSaleActor;
      source: SaleCorrectionSourceDto | null;
    },
  ): Promise<{ id: number; number: string }> {
    const ticket = await this.incrementTicketNumberAction.execute(
      manager,
      params.companyId,
      TicketSettingType.CREDIT_NOTE,
    );
    const total = params.lines.reduce((s, l) => s.plus(toBig(l.total)), toBig(0));
    const operationType = params.isFullVoidEdit
      ? OperationType.FULL_VOID
      : OperationType.PARTIAL_VOID;

    const cn = manager.create(CreditNote, {
      company_id: String(params.companyId),
      sale_invoice_id: params.sale.id,
      customer_id: params.customerId === null ? null : String(params.customerId),
      note_number: ticket.formatted,
      note_type: NoteType.CREDIT,
      operation_type: operationType,
      subtotal: preciseNumber(total, 2),
      tax_total: 0,
      total: preciseNumber(total, 2),
      reason: 'Edición de venta — productos removidos o reducidos',
      created_by: params.actor.fullName,
      created_by_id: String(params.actor.id),
      is_deleted: false,
    });
    const saved = await manager.save(CreditNote, cn);

    const cnLines = params.lines.map((l) => ({
      company_id: String(params.companyId),
      credit_note_id: saved.id,
      original_line_id: null as string | null,
      product_id: String(l.item_id),
      packaging_id: null as string | null,
      description: l.name,
      quantity: l.quantity,
      unit_price: l.price,
      unit_cost: l.cost,
      subtotal: l.total,
      iva_percentage: 0,
      iva_amount: 0,
      total: l.total,
    }));
    await manager.insert(CreditNoteLine, cnLines);

    await adjustInventory(
      manager,
      params.companyId,
      params.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })),
      'RETURN',
      {
        reason: 'SALE_EDIT_CREDIT',
        referenceType: 'credit_note',
        referenceId: Number(saved.id),
        referenceCode: saved.note_number,
        description: `NC por edición — ${saved.note_number}`,
        actorName: params.actor.fullName,
        actorUserId: params.actor.id,
        // La venta editada pudo incluir productos COMPARTIDOS del principal:
        // la devolución (NC) debe reponer el stock en el dueño REAL.
        crossCompanyAccess: true,
      },
    );

    if (params.isFullVoidEdit) {
      await manager.update(
        SaleInvoice,
        { id: params.sale.id, company_id: String(params.companyId) },
        { is_deleted: true },
      );
    }

    const creditTotal = preciseNumber(total, 2);
    if (creditTotal > 0 && params.source) {
      await this.applyCorrectionMovement(manager, {
        direction: 'CREDIT',
        amount: creditTotal,
        companyId: params.companyId,
        invoiceId: Number(params.sale.id),
        creditNoteId: Number(saved.id),
        noteNumber: saved.note_number,
        isFullVoid: params.isFullVoidEdit,
        actor: params.actor,
        source: params.source,
      });
    }

    return { id: Number(saved.id), number: saved.note_number };
  }

  /**
   * Crea ND `ADDITION` + ND lines, ajusta inventario `DEDUCT` y, si viene
   * `debit_correction_source`, registra el cobro adicional en caja o
   * `financial_movements`.
   */
  private async emitDebitNote(
    manager: EntityManager,
    params: {
      companyId: number;
      sale: SaleInvoice;
      customerId: number | null;
      lines: PlacePosLineDifference[];
      actor: UpdateSaleActor;
      source: SaleCorrectionSourceDto | null;
      overrideStock: boolean;
    },
  ): Promise<{ id: number; number: string }> {
    const ticket = await this.incrementTicketNumberAction.execute(
      manager,
      params.companyId,
      TicketSettingType.DEBIT_NOTE,
    );
    const total = params.lines.reduce((s, l) => s.plus(toBig(l.total)), toBig(0));

    const dn = manager.create(CreditNote, {
      company_id: String(params.companyId),
      sale_invoice_id: params.sale.id,
      customer_id: params.customerId === null ? null : String(params.customerId),
      note_number: ticket.formatted,
      note_type: NoteType.DEBIT,
      operation_type: OperationType.ADDITION,
      subtotal: preciseNumber(total, 2),
      tax_total: 0,
      total: preciseNumber(total, 2),
      reason: 'Edición de venta — productos añadidos o incrementados',
      created_by: params.actor.fullName,
      created_by_id: String(params.actor.id),
      is_deleted: false,
    });
    const saved = await manager.save(CreditNote, dn);

    const dnLines = params.lines.map((l) => ({
      company_id: String(params.companyId),
      credit_note_id: saved.id,
      original_line_id: null as string | null,
      product_id: String(l.item_id),
      packaging_id: null as string | null,
      description: l.name,
      quantity: l.quantity,
      unit_price: l.price,
      unit_cost: l.cost,
      subtotal: l.total,
      iva_percentage: 0,
      iva_amount: 0,
      total: l.total,
    }));
    await manager.insert(CreditNoteLine, dnLines);

    await adjustInventory(
      manager,
      params.companyId,
      params.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })),
      'DEDUCT',
      {
        reason: 'SALE_EDIT_DEBIT',
        referenceType: 'credit_note',
        referenceId: Number(saved.id),
        referenceCode: saved.note_number,
        description: `ND por edición — ${saved.note_number}`,
        actorName: params.actor.fullName,
        actorUserId: params.actor.id,
        // `override_stock` (autorizado solo a owner/superadmin en el caller)
        // permite que la ND deje el stock negativo — paridad PlacePos editSale.
        overrideStock: params.overrideStock,
        // La venta editada pudo incluir productos COMPARTIDOS del principal:
        // la ND (re-descuento) debe pegar en el stock del dueño REAL.
        crossCompanyAccess: true,
      },
    );

    const debitTotal = preciseNumber(total, 2);
    if (debitTotal > 0 && params.source) {
      await this.applyCorrectionMovement(manager, {
        direction: 'DEBIT',
        amount: debitTotal,
        companyId: params.companyId,
        invoiceId: Number(params.sale.id),
        creditNoteId: Number(saved.id),
        noteNumber: saved.note_number,
        isFullVoid: false,
        actor: params.actor,
        source: params.source,
      });
    }

    return { id: Number(saved.id), number: saved.note_number };
  }

  /**
   * Registra el reembolso (CREDIT) o cobro adicional (DEBIT) en la cuenta
   * destino. Espejo PlacePos:
   *
   *   - `cash_register` → CashRegisterLog (CREDIT_NOTE_FULL_VOID,
   *     CREDIT_NOTE_PARTIAL_VOID o DEBIT_NOTE) + UPDATE balance.
   *   - `bank` / `wallet` → FinancialMovement (INCOME para DEBIT, EXPENSE
   *     para CREDIT). El ownership multi-tenant lo verifica el
   *     `RecordFinancialMovementAction`.
   */
  private async applyCorrectionMovement(
    manager: EntityManager,
    params: {
      direction: 'CREDIT' | 'DEBIT';
      amount: number;
      companyId: number;
      invoiceId: number;
      creditNoteId: number;
      noteNumber: string;
      isFullVoid: boolean;
      actor: UpdateSaleActor;
      source: SaleCorrectionSourceDto;
    },
  ): Promise<void> {
    if (params.source.type === 'cash_register') {
      const type =
        params.direction === 'CREDIT'
          ? params.isFullVoid
            ? CashRegisterLogType.CREDIT_NOTE_FULL_VOID
            : CashRegisterLogType.CREDIT_NOTE_PARTIAL_VOID
          : CashRegisterLogType.DEBIT_NOTE;
      const direction = params.direction === 'CREDIT' ? 'OUT' : 'IN';

      // Validar ownership multi-tenant de la cash_register.
      const register = await manager.findOne(CashRegister, {
        where: {
          id: String(params.source.id),
          company_id: String(params.companyId),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!register) {
        throw new UnprocessableEntityException(
          'La caja registradora seleccionada no pertenece a la empresa',
        );
      }

      const currentBalance = toBig(register.balance);
      const newBalance =
        params.direction === 'CREDIT'
          ? currentBalance.minus(params.amount)
          : currentBalance.plus(params.amount);
      if (params.direction === 'CREDIT' && newBalance.lt(0)) {
        throw new UnprocessableEntityException({
          message:
            'El saldo de la caja no alcanza para reversar la nota crédito. Selecciona otra cuenta o reconcilia manualmente.',
          payload: {
            code: 'INSUFFICIENT_REGISTER_BALANCE',
            required: params.amount,
            available: Number(register.balance),
          },
        });
      }
      await manager.update(
        CashRegister,
        { id: register.id, company_id: String(params.companyId) },
        { balance: Number(newBalance.toFixed(2)) },
      );

      const log = manager.create(CashRegisterLog, {
        company_id: String(params.companyId),
        cash_register_id: register.id,
        type,
        direction,
        amount: params.amount,
        affects_balance: true,
        invoice_id: String(params.invoiceId),
        credit_note_id: String(params.creditNoteId),
        description: this.buildCorrectionDescription(params),
        created_by: params.actor.fullName,
        created_by_id: String(params.actor.id),
        is_credit_related: false,
      });
      await manager.save(CashRegisterLog, log);
      return;
    }

    // bank / wallet → FinancialMovement.
    // I-6: el caso DEBIT (cobro adicional por edición) debe usar
    // `SALE_PAYMENT` — el concept `SALE` es para la creación inicial de la
    // venta, no para cobros incrementales. CREDIT (reembolso por NC)
    // mantiene `CREDIT_NOTE_REFUND`.
    const movementType = params.direction === 'CREDIT' ? MovementType.EXPENSE : MovementType.INCOME;
    const concept =
      params.direction === 'CREDIT'
        ? MovementConcept.CREDIT_NOTE_REFUND
        : MovementConcept.SALE_PAYMENT;

    await this.financialMovementsService.record(manager, {
      companyId: params.companyId,
      amount: params.amount,
      movement_type: movementType,
      concept,
      description: this.buildCorrectionDescription(params),
      source_type: params.direction === 'CREDIT' ? params.source.type : null,
      source_id: params.direction === 'CREDIT' ? params.source.id : null,
      destination_type: params.direction === 'DEBIT' ? params.source.type : null,
      destination_id: params.direction === 'DEBIT' ? params.source.id : null,
      reference_code: params.noteNumber,
      created_by: params.actor.fullName,
      created_by_id: params.actor.id,
    });
  }

  private buildCorrectionDescription(params: {
    direction: 'CREDIT' | 'DEBIT';
    noteNumber: string;
    invoiceId: number;
  }): string {
    if (params.direction === 'CREDIT') {
      return `Reembolso por edición de venta — Nota crédito ${params.noteNumber} (venta #${params.invoiceId})`;
    }
    return `Cobro adicional por edición de venta — Nota débito ${params.noteNumber} (venta #${params.invoiceId})`;
  }
}

/**
 * Calcula el delta entre las líneas vivas consolidadas (shape PlacePos) y
 * las del payload de edición. Espejo `calculateLineDifferences` de PlacePos.
 *
 * Comparación por `item_id`. El `total` de cada diferencia se calcula como
 * `price * qty_diff` (sin IVA — paridad PlacePos: las CN/DN de edición no
 * llevan IVA en local).
 */
function calculatePlacePosLineDifferences(
  consolidated: ConsolidatedLine[],
  payload: UpdateSaleLineDto[],
): { removedOrReduced: PlacePosLineDifference[]; addedOrIncreased: PlacePosLineDifference[] } {
  const currentMap = new Map<number, ConsolidatedLine>();
  for (const line of consolidated) {
    currentMap.set(Number(line.item_id), line);
  }

  // Si el cliente envía dos líneas para el MISMO producto, las consolidamos
  // antes de calcular delta (PlacePos no lo contempla pero el contrato del
  // DTO no lo impide).
  const newMap = new Map<number, { line: UpdateSaleLineDto; quantity: Big; total: Big }>();
  for (const line of payload) {
    const key = Number(line.item_id);
    const existing = newMap.get(key);
    if (existing) {
      existing.quantity = existing.quantity.plus(toBig(line.quantity));
      existing.total = existing.total.plus(toBig(line.total));
    } else {
      newMap.set(key, {
        line,
        quantity: toBig(line.quantity),
        total: toBig(line.total),
      });
    }
  }

  const removedOrReduced: PlacePosLineDifference[] = [];
  const addedOrIncreased: PlacePosLineDifference[] = [];

  for (const [itemId, currentLine] of currentMap) {
    const newEntry = newMap.get(itemId);
    if (!newEntry) {
      removedOrReduced.push({
        type: 'removed',
        item_id: Number(currentLine.item_id),
        name: currentLine.name,
        cost: Number(currentLine.cost),
        price: Number(currentLine.price),
        quantity: Number(currentLine.quantity),
        total: Number(currentLine.total),
      });
      continue;
    }
    const currentQty = toBig(currentLine.quantity);
    if (newEntry.quantity.lt(currentQty)) {
      const diffQty = currentQty.minus(newEntry.quantity);
      removedOrReduced.push({
        type: 'reduced',
        item_id: Number(currentLine.item_id),
        name: currentLine.name,
        cost: Number(currentLine.cost),
        price: Number(currentLine.price),
        quantity: preciseNumber(diffQty, 4),
        total: preciseNumber(toBig(currentLine.price).times(diffQty), 2),
      });
    }
  }

  for (const [itemId, newEntry] of newMap) {
    const currentLine = currentMap.get(itemId);
    if (!currentLine) {
      addedOrIncreased.push({
        type: 'added',
        item_id: itemId,
        name: newEntry.line.name,
        cost: newEntry.line.cost,
        price: newEntry.line.price,
        quantity: preciseNumber(newEntry.quantity, 4),
        total: preciseNumber(newEntry.total, 2),
      });
      continue;
    }
    const currentQty = toBig(currentLine.quantity);
    if (newEntry.quantity.gt(currentQty)) {
      const diffQty = newEntry.quantity.minus(currentQty);
      addedOrIncreased.push({
        type: 'increased',
        item_id: itemId,
        name: newEntry.line.name,
        cost: newEntry.line.cost,
        price: newEntry.line.price,
        quantity: preciseNumber(diffQty, 4),
        total: preciseNumber(toBig(newEntry.line.price).times(diffQty), 2),
      });
    }
  }

  return { removedOrReduced, addedOrIncreased };
}

/**
 * Shape parcial listo para `manager.insert(SaleInvoiceLine, ...)`. Espeja
 * las columnas no-default obligatorias de `sale_invoice_lines`.
 */
interface SaleInvoiceLineInsertRow {
  company_id: string;
  sale_invoice_id: string;
  product_id: string;
  packaging_id: string | null;
  product_price_id: string | null;
  description: string;
  note: string | null;
  quantity: number;
  unit_price: number;
  unit_cost: number;
  subtotal: number;
  iva_percentage: number;
  iva_amount: number;
  total: number;
  profit: number;
  margin: number;
}

/**
 * Mapea una línea del payload PlacePos al row listo para INSERT en
 * `sale_invoice_lines`. Los campos cloud-only (`packaging_id`,
 * `product_price_id`, IVA) quedan en su valor neutro — el modo
 * servidor/cliente no maneja esos conceptos en ventas.
 */
function mapPayloadLineToRow(
  line: UpdateSaleLineDto,
  saleInvoiceId: string,
  companyId: number,
): SaleInvoiceLineInsertRow {
  return {
    company_id: String(companyId),
    sale_invoice_id: saleInvoiceId,
    product_id: String(line.item_id),
    packaging_id: null,
    product_price_id: null,
    description: line.name,
    note: line.note ?? null,
    quantity: line.quantity,
    unit_price: line.price,
    unit_cost: line.cost,
    subtotal: line.total,
    iva_percentage: 0,
    iva_amount: 0,
    total: line.total,
    profit: line.profit,
    margin: line.margin,
  };
}
