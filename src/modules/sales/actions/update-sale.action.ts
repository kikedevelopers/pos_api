import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { CreditNote, OperationType } from '@/modules/credit-notes/entities/credit-note.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product, ProductType } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';

import { UpdateSaleDto } from '../dto/update-sale.dto';
import { SaleCredit } from '../entities/sale-credit.entity';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import { calculateSaleTotals } from '../internal/calculate-sale-totals';
import { computeLineDelta, type LineDifference } from '../internal/compute-line-delta';
import {
  getConsolidatedInvoice,
  type ConsolidatedInvoice,
} from '../internal/consolidate-invoice.helper';
import { translateSaleConstraintError } from '../internal/constraint-errors';
import { generateEditNotes } from '../internal/generate-edit-notes';
import { assertMarginAboveMinimum } from '../internal/margin-guard.helper';
import {
  findSaleCredit,
  findSaleInCompany,
  findSaleLines,
  findSalePayments,
} from '../internal/sale-lookups';
import type { SaleAggregate } from './find-sale.action';

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

/**
 * Edita una venta. Espejo del `editTicket` (`editOrder` + `editSale`) de
 * PlacePos `editOperations.ts` (807 líneas), con las particularidades del
 * cloud (multi-tenant, idempotencia diferente, sin `correction_source`
 * implícito en CASH).
 *
 * --------------------------------------------------------------------------
 * Rutas según `ticket_type`
 * --------------------------------------------------------------------------
 *
 *   1. `ORDER`: reemplazo total — sin pagos, sin NC/ND, sin caja, sin stock.
 *      Equivalente a PlacePos `editOrder`.
 *
 *   2. `SALE`:
 *      - Si NO hay delta de líneas y NO cambia el cliente → no-op (paridad
 *        PlacePos: PUT sin cambios devuelve la venta tal cual).
 *      - Si NO hay delta de líneas y SÍ cambia el cliente → UPDATE
 *        `customer_*` solamente (con guard de SaleCredit con abonos).
 *      - Si hay delta → emite NC `PARTIAL_VOID` (removed/reduced) y ND
 *        `ADDITION` (added/increased), ajusta inventario diferencial y
 *        recalcula los totales consolidados de la cabecera.
 *
 * --------------------------------------------------------------------------
 * Transacción SERIALIZABLE
 * --------------------------------------------------------------------------
 *
 * El flujo:
 *   - Lockea la venta con `pessimistic_write`.
 *   - Lee notas existentes (FULL_VOID activo bloquea).
 *   - Genera folios CN/DN atómicos vía `IncrementTicketNumberAction`.
 *   - Muta cabecera + inserta NC/ND + ajusta stock.
 *
 * Concurrencia con un cobro paralelo (`POST /payments`) puede afectar el
 * SaleCredit y el customer.balance; SERIALIZABLE protege contra anomalías
 * de lectura no repetible cuando se evalúa el delta + balance del crédito.
 * Espejo CLAUDE.md §9.4.
 *
 * --------------------------------------------------------------------------
 * Side effects de caja: deliberadamente AUSENTES
 * --------------------------------------------------------------------------
 *
 * PlacePos local registra `registerCreditNotePartialVoid` /
 * `registerDebitNoteIncome` (movimientos en caja / banco / wallet) solo
 * cuando el cliente envía `credit_correction_source` / `debit_correction_source`
 * EXPLÍCITOS. El cloud heredará esa misma API en una iteración posterior
 * cuando se implementen las DTOs de correction source (paridad PlacePos
 * exige el explícito — no inferimos cuenta destino del pago original).
 *
 * Hoy `PUT /sales/:id` NO toca caja/banco/wallet ni emite FinancialMovement —
 * dejamos los ajustes financieros a `POST /payments` o a un flujo manual
 * separado. Esto evita des-cuadres silenciosos si el operador edita una
 * venta cuyos pagos fueron por TRANSFER (un escenario donde PlacePos local
 * exige `correction_source.bank` obligatorio). Riesgo abierto: ver reporte
 * para security-auditor.
 */
@Injectable()
export class UpdateSaleAction {
  private readonly logger = new Logger(UpdateSaleAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly incrementTicketNumberAction: IncrementTicketNumberAction,
  ) {}

  async execute(
    id: number,
    dto: UpdateSaleDto,
    companyId: number,
    actor: UpdateSaleActor,
  ): Promise<SaleAggregate> {
    return this.dataSource.transaction<SaleAggregate>('SERIALIZABLE', async (manager) =>
      this.run(manager, id, dto, companyId, actor),
    );
  }

  private async run(
    manager: EntityManager,
    id: number,
    dto: UpdateSaleDto,
    companyId: number,
    actor: UpdateSaleActor,
  ): Promise<SaleAggregate> {
    // 0. Enforcement early de `override_margin`. Solo `owner | superadmin`
    //    pueden activar la flag — `manager`/`employee` reciben 403 ANTES de
    //    cualquier mutación (defensa en profundidad: el guard de margen ya lo
    //    rechazaba más adentro, pero queremos fail-fast con código explícito).
    if (dto.override_margin === true && actor.type !== 'owner' && actor.type !== 'superadmin') {
      throw new ForbiddenException({
        message: 'Solo el dueño puede forzar el override de margen mínimo.',
        payload: { code: 'OVERRIDE_NOT_ALLOWED' },
      });
    }

    // 1. Lookup + lock pessimistic_write (sobre la cabecera).
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
  ): Promise<SaleAggregate> {
    const patch: Partial<SaleInvoice> = {};

    if (dto.customer_id !== undefined) {
      const resolved = await this.resolveCustomer(manager, dto.customer_id, companyId);
      patch.customer_id = resolved.customerId;
      patch.customer_name = resolved.customerName;
    }
    if (dto.notes !== undefined) {
      patch.notes = dto.notes === null ? null : dto.notes?.trim() || null;
    }

    if (dto.lines !== undefined && dto.lines.length > 0) {
      const totals = await this.loadAndCalculateTotals(manager, dto, companyId);
      // ORDER en PlacePos no toca el margen (no hay reglas) — el guard sí lo
      // valida en POS local cuando se confirma. En la edición de un ORDER el
      // margen puede ser temporalmente bajo sin generar 422.

      await manager.delete(SaleInvoiceLine, {
        sale_invoice_id: sale.id,
        company_id: String(companyId),
      });
      const lineRows = totals.lines.map((l) => ({ ...l, sale_invoice_id: sale.id }));
      await manager.insert(SaleInvoiceLine, lineRows);

      patch.subtotal = totals.subtotal;
      patch.tax_total = totals.tax_total;
      patch.total = totals.total;
      patch.cost = totals.cost;
      patch.profit = totals.profit;
      patch.margin = totals.margin;
    }

    if (Object.keys(patch).length > 0) {
      try {
        await manager.update(SaleInvoice, { id: sale.id, company_id: String(companyId) }, patch);
      } catch (error) {
        translateSaleConstraintError(error);
        throw error;
      }
    }

    this.logger.log({
      event: 'sale.updated.order',
      companyId,
      saleId: Number(sale.id),
      fieldsTouched: Object.keys(patch),
      actorId: actor.id,
    });

    return this.loadAggregate(manager, Number(sale.id), companyId);
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
  ): Promise<SaleAggregate> {
    // FULL_VOID activo → bloquea: una venta anulada no se edita.
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

    // Cargar estado consolidado VIVO (con todas las NC/ND aplicadas).
    const consolidated = await getConsolidatedInvoice(manager, companyId, Number(sale.id));
    if (!consolidated) {
      throw new NotFoundException('Venta no encontrada');
    }

    const customerChange = this.evaluateCustomerChange(dto, sale);

    // Si no llegan líneas, solo se permite cambio de cliente / notas.
    if (dto.lines === undefined) {
      return this.applyCustomerOnlyChange(manager, sale, dto, companyId, actor, customerChange);
    }

    // Calcular totales del payload con Big.js (mismo helper que create-sale).
    const computedPayload = await this.loadAndCalculateTotals(manager, dto, companyId);

    // Delta vs líneas vivas consolidadas.
    const delta = computeLineDelta(consolidated.lines, computedPayload.lines);

    if (delta.isEmpty) {
      // Sin cambios en líneas — solo posible cambio de cliente / notas.
      return this.applyCustomerOnlyChange(manager, sale, dto, companyId, actor, customerChange);
    }

    // Validar margen consolidado SOLO si hay ND (productos añadidos /
    // aumentados). Una NC pura siempre baja el margen — paridad PlacePos.
    if (delta.addedOrIncreased.length > 0) {
      const consolidatedTotals = this.computeConsolidatedTotalsAfterEdit(
        consolidated,
        delta.removedOrReduced,
        delta.addedOrIncreased,
      );
      await assertMarginAboveMinimum({
        manager,
        companyId,
        total: consolidatedTotals.total,
        cost: consolidatedTotals.cost,
        overrideMargin: dto.override_margin === true,
        userType: actor.type,
        messagePrefix: 'El margen consolidado de la venta',
      });
    }

    // Resolver el cliente final (si cambió) y aplicar guard de SaleCredit.
    let finalCustomerId: number | null = customerChange.changed
      ? customerChange.newCustomerId
      : consolidated.customerId;
    let finalCustomerName: string | null = customerChange.changed
      ? customerChange.newCustomerName
      : sale.customer_name;
    if (customerChange.changed) {
      await this.assertNoLockedCredit(manager, Number(sale.id), companyId);
      const resolved = await this.resolveCustomer(manager, dto.customer_id ?? null, companyId);
      finalCustomerId = resolved.customerId === null ? null : Number(resolved.customerId);
      finalCustomerName = resolved.customerName;
    }

    // Emitir NC / ND atómicamente.
    const notesResult = await generateEditNotes(manager, this.incrementTicketNumberAction, {
      companyId,
      saleInvoiceId: Number(sale.id),
      customerId: finalCustomerId,
      removedOrReduced: delta.removedOrReduced,
      addedOrIncreased: delta.addedOrIncreased,
      actor: { id: actor.id, fullName: actor.fullName },
    });

    // Inventario diferencial — solo para SALE (las ORDER no consumieron stock).
    if (delta.removedOrReduced.length > 0) {
      await adjustInventory(
        manager,
        companyId,
        delta.removedOrReduced.map((l) => ({ item_id: l.product_id, quantity: l.quantity })),
        'RETURN',
      );
    }
    if (delta.addedOrIncreased.length > 0) {
      await adjustInventory(
        manager,
        companyId,
        delta.addedOrIncreased.map((l) => ({ item_id: l.product_id, quantity: l.quantity })),
        'DEDUCT',
      );
    }

    // UPDATE cabecera: el `SaleInvoice.total` / `cost` / `profit` / `margin`
    // conservan los valores ORIGINALES de la venta — PlacePos hace lo mismo.
    // Los totales consolidados se derivan dinámicamente (NC/ND aplicadas).
    // Solo persistimos cambios de customer/notes.
    const patch: Partial<SaleInvoice> = {};
    if (customerChange.changed) {
      patch.customer_id = finalCustomerId === null ? null : String(finalCustomerId);
      patch.customer_name = finalCustomerName;
    }
    if (dto.notes !== undefined) {
      patch.notes = dto.notes === null ? null : dto.notes?.trim() || null;
    }
    if (Object.keys(patch).length > 0) {
      try {
        await manager.update(SaleInvoice, { id: sale.id, company_id: String(companyId) }, patch);
      } catch (error) {
        translateSaleConstraintError(error);
        throw error;
      }
    }

    this.logger.log({
      event: 'sale.updated.sale',
      companyId,
      saleId: Number(sale.id),
      creditNoteId: notesResult.creditNoteId,
      creditNoteNumber: notesResult.creditNoteNumber,
      debitNoteId: notesResult.debitNoteId,
      debitNoteNumber: notesResult.debitNoteNumber,
      customerChanged: customerChange.changed,
      removed: delta.removedOrReduced.length,
      added: delta.addedOrIncreased.length,
      actorId: actor.id,
    });

    return this.loadAggregate(manager, Number(sale.id), companyId);
  }

  // --------------------------------------------------------------------------
  // Helpers privados
  // --------------------------------------------------------------------------

  /**
   * Aplica un UPDATE de customer / notes cuando NO hay delta de líneas. Si
   * NADA cambió, es un no-op contractual (paridad PlacePos).
   */
  private async applyCustomerOnlyChange(
    manager: EntityManager,
    sale: SaleInvoice,
    dto: UpdateSaleDto,
    companyId: number,
    actor: UpdateSaleActor,
    customerChange: CustomerChangeEvaluation,
  ): Promise<SaleAggregate> {
    const patch: Partial<SaleInvoice> = {};
    if (customerChange.changed) {
      await this.assertNoLockedCredit(manager, Number(sale.id), companyId);
      const resolved = await this.resolveCustomer(manager, dto.customer_id ?? null, companyId);
      patch.customer_id = resolved.customerId;
      patch.customer_name = resolved.customerName;
    }
    if (dto.notes !== undefined) {
      patch.notes = dto.notes === null ? null : dto.notes?.trim() || null;
    }
    if (Object.keys(patch).length > 0) {
      try {
        await manager.update(SaleInvoice, { id: sale.id, company_id: String(companyId) }, patch);
      } catch (error) {
        translateSaleConstraintError(error);
        throw error;
      }
      this.logger.log({
        event: 'sale.updated.sale.customer_only',
        companyId,
        saleId: Number(sale.id),
        fieldsTouched: Object.keys(patch),
        actorId: actor.id,
      });
    }
    return this.loadAggregate(manager, Number(sale.id), companyId);
  }

  /**
   * Devuelve `customerId` y `customerName` listos para persistir según el
   * shape de la entidad (`string | null`). Valida ownership multi-tenant y
   * que no esté archivado. Si `customerId === null` representa venta
   * mostrador (sin cliente). El `undefined` no llega aquí — el caller filtra.
   */
  private async resolveCustomer(
    manager: EntityManager,
    customerId: number | null | undefined,
    companyId: number,
  ): Promise<{ customerId: string | null; customerName: string | null }> {
    if (customerId === null || customerId === undefined) {
      return { customerId: null, customerName: null };
    }
    const customer = await manager.findOne(Customer, {
      where: {
        id: String(customerId),
        company_id: String(companyId),
        is_archived: false,
      },
      select: { id: true, name: true },
    });
    if (!customer) {
      throw new UnprocessableEntityException('Cliente no encontrado o archivado');
    }
    return { customerId: customer.id, customerName: customer.name };
  }

  /**
   * Bloquea el cambio de cliente cuando la venta tiene un `SaleCredit` con
   * pagos aplicados — espejo PlacePos `assertNoLockedCredit`. Reasignar el
   * cliente transferiría silenciosamente la cartera al nuevo cliente.
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
   * Compara el cliente del payload contra el de la venta consolidada usando
   * solo el `id` (incluyendo null=null). Paridad PlacePos.
   *
   * `undefined` en el DTO se interpreta como "no tocar" — no como "limpiar".
   */
  private evaluateCustomerChange(dto: UpdateSaleDto, sale: SaleInvoice): CustomerChangeEvaluation {
    if (dto.customer_id === undefined) {
      return { changed: false, newCustomerId: null, newCustomerName: null };
    }
    const currentId = sale.customer_id === null ? null : Number(sale.customer_id);
    const newId = dto.customer_id === null ? null : Number(dto.customer_id);
    if (currentId === newId) {
      return { changed: false, newCustomerId: null, newCustomerName: null };
    }
    return { changed: true, newCustomerId: newId, newCustomerName: null };
  }

  /**
   * Carga productos / packagings / product_prices del payload validando
   * ownership multi-tenant; recalcula totales con Big.js. Espejo de los
   * pasos 2-5 del `create-sale.action`.
   */
  private async loadAndCalculateTotals(
    manager: EntityManager,
    dto: UpdateSaleDto,
    companyId: number,
  ): Promise<ReturnType<typeof calculateSaleTotals>> {
    if (!dto.lines) {
      throw new BadRequestException('lines requerido para recalcular totales');
    }

    const productIds = Array.from(new Set(dto.lines.map((l) => String(l.product_id))));
    const products = await manager.find(Product, {
      where: { id: In(productIds), company_id: String(companyId) },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException('Uno o más productos no existen');
    }
    const invalidProduct = products.find(
      (p) => p.product_type !== ProductType.SIMPLE || p.is_archived,
    );
    if (invalidProduct) {
      throw new BadRequestException(
        `El producto "${invalidProduct.name}" no es un producto simple disponible`,
      );
    }
    const productById = new Map(products.map((p) => [Number(p.id), p]));

    const packagingIds = Array.from(
      new Set(
        dto.lines
          .map((l) => l.packaging_id)
          .filter((idv): idv is number => typeof idv === 'number' && idv > 0)
          .map((idv) => String(idv)),
      ),
    );
    const packagingById = new Map<number, Packaging>();
    if (packagingIds.length > 0) {
      const packagings = await manager.find(Packaging, {
        where: {
          id: In(packagingIds),
          company_id: String(companyId),
          is_archived: false,
        },
      });
      if (packagings.length !== packagingIds.length) {
        throw new BadRequestException('Uno o más empaques no existen o están archivados');
      }
      for (const p of packagings) {
        packagingById.set(Number(p.id), p);
      }
    }

    const productPriceIds = Array.from(
      new Set(
        dto.lines
          .map((l) => l.product_price_id)
          .filter((idv): idv is number => typeof idv === 'number' && idv > 0)
          .map((idv) => String(idv)),
      ),
    );
    const productPriceById = new Map<number, ProductPrice>();
    if (productPriceIds.length > 0) {
      const prices = await manager.find(ProductPrice, {
        where: { id: In(productPriceIds), company_id: String(companyId) },
      });
      if (prices.length !== productPriceIds.length) {
        throw new BadRequestException('Uno o más niveles de precio no existen');
      }
      for (const p of prices) {
        productPriceById.set(Number(p.id), p);
      }
    }

    return calculateSaleTotals(dto.lines, companyId, productById, packagingById, productPriceById);
  }

  /**
   * Calcula los totales consolidados tras aplicar el delta sin tener que
   * leer las notas de DB (las acabamos de calcular en memoria). Espejo
   * algebraico del `aggregateConsolidatedLines` de PlacePos.
   *
   *   total_post = invoice.consolidated.total - Σ removedOrReduced.total
   *                                            + Σ addedOrIncreased.total
   *   cost_post  = invoice.consolidated.cost  - Σ (cost*qty)_removed
   *                                            + Σ (cost*qty)_added
   */
  private computeConsolidatedTotalsAfterEdit(
    consolidated: ConsolidatedInvoice,
    removed: LineDifference[],
    added: LineDifference[],
  ): { total: number; cost: number } {
    let total = toBig(consolidated.total);
    let cost = toBig(consolidated.cost);
    for (const r of removed) {
      total = total.minus(r.total);
      cost = cost.minus(toBig(r.unit_cost).times(r.quantity));
    }
    for (const a of added) {
      total = total.plus(a.total);
      cost = cost.plus(toBig(a.unit_cost).times(a.quantity));
    }
    return {
      total: preciseNumber(total, 2),
      cost: preciseNumber(cost, 2),
    };
  }

  private async loadAggregate(
    manager: EntityManager,
    saleId: number,
    companyId: number,
  ): Promise<SaleAggregate> {
    const reloaded = await manager.findOne(SaleInvoice, {
      where: { id: String(saleId), company_id: String(companyId) },
    });
    if (!reloaded) {
      throw new NotFoundException('Venta no encontrada tras actualizar');
    }
    const lines = await findSaleLines(manager, saleId, companyId);
    const payments = await findSalePayments(manager, saleId, companyId);
    const credit = await findSaleCredit(manager, saleId, companyId);
    return { sale: reloaded, lines, payments, credit };
  }
}

interface CustomerChangeEvaluation {
  changed: boolean;
  newCustomerId: number | null;
  newCustomerName: string | null;
}
