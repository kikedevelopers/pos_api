import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryFailedError, type EntityManager } from 'typeorm';

import { GetEnableThirdPartyLoanAction } from '@/modules/app-settings/actions/get-enable-third-party-loan.action';
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';

import { SaleStatusEventType } from '../entities/sale-status-history.entity';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import type { ProcessLoanDto } from '../dto/process-loan.dto';
import { recordSaleStatus } from '../internal/record-sale-status.helper';

/**
 * Actor que registra el préstamo (User u Employee logueado). Solo capturamos
 * los campos que la action consume — molde de `ProcessPaymentActor`.
 */
export interface ProcessLoanActor {
  id: number;
  fullName: string;
  /** `owner | manager | employee | superadmin`. Solo `owner` puede prestar. */
  type: string | null;
}

/**
 * Resultado de `POST /sales/:id/loan`.
 *
 * El controller traduce:
 *   - `success === true`  → 201 (o 200 si es replay idempotente) con
 *     `{ success: true, payload: result }`.
 *   - `success === false` → 422 con `{ success: false, error, payload: { code } }`.
 *
 * Los gates 403 (`LOAN_NOT_OWNER`, `LOAN_DISABLED`) NO pasan por este result:
 * la action lanza `ForbiddenException` directamente (403). `INSUFFICIENT_STOCK`
 * lo lanza `adjustInventory` como `UnprocessableEntityException` (422) con el
 * mismo `payload.code` que en pagos, y se propaga al filtro global.
 */
export interface ProcessLoanResult {
  success: boolean;
  message: string;
  invoice_id: number | null;
  ticket_number: string | null;
  /** Un préstamo NUNCA es una venta: `sale_number` siempre null. */
  sale_number: null;
  code?: string;
  /**
   * Marca interna: `true` cuando el resultado proviene del fast-path
   * idempotente (la request es un reintento, no un nuevo préstamo). El
   * controller la usa para devolver 200 en vez de 201 y la elimina antes de
   * responder — no forma parte del contrato HTTP.
   */
  replay?: boolean;
}

/**
 * Códigos de error de `POST /sales/:id/loan`. Mismo estilo textual que
 * `POST /payments` para que el front ramifique sin diff.
 */
const ERR = {
  INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',
  INVOICE_NOT_ORDER: 'INVOICE_NOT_ORDER',
  LOAN_REQUIRES_CUSTOMER: 'LOAN_REQUIRES_CUSTOMER',
  DUPLICATE_OPERATION: 'DUPLICATE_OPERATION',
} as const;

/** Gate: el actor no es el dueño. */
const LOAN_NOT_OWNER = 'LOAN_NOT_OWNER';
/** Gate fail-closed: la feature está apagada para el negocio. */
const LOAN_DISABLED = 'LOAN_DISABLED';
/** unique_violation de Postgres. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Convierte un pedido (ORDER) en un préstamo de mercancía a un tercero
 * (`ticket_type = 'LOAN'`).
 *
 * --------------------------------------------------------------------------
 * Espejo de `ProcessPaymentAction` pero SIN dinero
 * --------------------------------------------------------------------------
 *
 * Reutiliza los pasos 1-2, 7-8, la idempotencia y el status-history del cobro,
 * pero OMITE todo lo de dinero/crédito/caja/puntos:
 *
 *   0. Gate owner-only (403 `LOAN_NOT_OWNER`) + gate fail-closed del setting
 *      `enable_third_party_loan` leído de la BD (403 `LOAN_DISABLED`).
 *   0.5. Fast-path idempotente: si ya existe un LOAN con este
 *      `client_operation_id`, se devuelve el resultado previo (replay) sin
 *      reprocesar — no hay doble descuento de stock.
 *   1. Lock + lookup `SaleInvoice` por `(id, company_id, is_deleted=false)`.
 *   2. Idempotencia dentro de la TX: si el pedido ya es LOAN con esta misma
 *      llave → replay. Si `ticket_type !== 'ORDER'` → `INVOICE_NOT_ORDER`.
 *   3. `customer_id` NULL → `LOAN_REQUIRES_CUSTOMER` (exige cliente, como el
 *      crédito).
 *   4. UPDATE `ticket_type='LOAN'`, `sold_at=now()`, `client_operation_id`
 *      persistido; `sale_number` queda NULL.
 *   5. `adjustInventory(... 'DEDUCT')` con `overrideStock = override_stock &&
 *      owner`. Sin override y stock insuficiente → `INSUFFICIENT_STOCK` (422).
 *   6. `recordSaleStatus(LOANED)`.
 *
 * --------------------------------------------------------------------------
 * Aislamiento SERIALIZABLE
 * --------------------------------------------------------------------------
 *
 * Igual que el cobro: lock pesimista sobre la factura + mutación de stock de
 * varios productos en la misma TX. SERIALIZABLE protege contra dos préstamos
 * concurrentes sobre el mismo pedido. Si `adjustInventory` aborta por stock
 * insuficiente, el rollback revierte la conversión (no queda un LOAN a medias).
 */
@Injectable()
export class ConvertOrderToLoanAction {
  private readonly logger = new Logger(ConvertOrderToLoanAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly getEnableThirdPartyLoanAction: GetEnableThirdPartyLoanAction,
  ) {}

  async execute(
    invoiceId: number,
    dto: ProcessLoanDto,
    companyId: number,
    actor: ProcessLoanActor,
  ): Promise<ProcessLoanResult> {
    // 0. Gate owner-only. Ningún empleado (ni admin) puede prestar. Fail-fast
    //    con código explícito ANTES de tocar la BD.
    if (actor.type !== 'owner') {
      throw new ForbiddenException({
        message: 'Solo el dueño puede registrar préstamos a terceros.',
        payload: { code: LOAN_NOT_OWNER },
      });
    }

    // 0.1. Gate fail-closed del setting, revalidado contra la BD (estilo
    //      ElectronicBillingGuard): el front pudo quedar rancio.
    const { enabled } = await this.getEnableThirdPartyLoanAction.execute(companyId);
    if (!enabled) {
      throw new ForbiddenException({
        message: 'Los préstamos a terceros no están habilitados para este negocio.',
        payload: { code: LOAN_DISABLED },
      });
    }

    // 0.5. Fast-path idempotente: la operación ya se procesó (mismo uuid). El
    //      índice único parcial `uq_sale_invoices_client_operation` garantiza
    //      que a lo sumo un LOAN lleva esta llave en la company.
    const replay = await this.tryReplayIdempotent(companyId, dto.client_operation_id);
    if (replay) {
      return replay;
    }

    try {
      return await this.dataSource.transaction<ProcessLoanResult>('SERIALIZABLE', async (manager) =>
        this.run(manager, invoiceId, dto, companyId, actor),
      );
    } catch (error) {
      // unique_violation sobre `client_operation_id`: otra request (carrera)
      // ya reclamó esta llave. El rollback revirtió esta conversión; devolvemos
      // el préstamo ya existente como replay idempotente.
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        const raced = await this.tryReplayIdempotent(companyId, dto.client_operation_id);
        if (raced) {
          return raced;
        }
        return {
          success: false,
          message: 'La operación ya fue procesada.',
          invoice_id: null,
          ticket_number: null,
          sale_number: null,
          code: ERR.DUPLICATE_OPERATION,
        };
      }
      throw error;
    }
  }

  private async run(
    manager: EntityManager,
    invoiceId: number,
    dto: ProcessLoanDto,
    companyId: number,
    actor: ProcessLoanActor,
  ): Promise<ProcessLoanResult> {
    // 1. Lookup pedido con lock pessimistic_write.
    const sale = await manager.findOne(SaleInvoice, {
      where: {
        id: String(invoiceId),
        company_id: String(companyId),
        is_deleted: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!sale) {
      return this.fail('Factura no encontrada', ERR.INVOICE_NOT_FOUND);
    }

    // 2. Idempotencia dentro de la TX: si este mismo pedido ya se convirtió con
    //    esta llave (carrera que ganó la otra request), devolvemos replay.
    if (sale.ticket_type === TicketType.LOAN && sale.client_operation_id === dto.client_operation_id) {
      return this.replayFromSale(sale);
    }

    // 2.1. Solo un ORDER es convertible.
    if (sale.ticket_type !== TicketType.ORDER) {
      return this.fail(
        'Solo se puede prestar un pedido (ORDER)',
        ERR.INVOICE_NOT_ORDER,
      );
    }

    // 3. Exige cliente (igual que el crédito): un préstamo va a un tercero.
    if (!sale.customer_id) {
      return this.fail(
        'No se puede registrar un préstamo sin un cliente asignado a la factura',
        ERR.LOAN_REQUIRES_CUSTOMER,
      );
    }

    // 4. UPDATE: el pedido pasa a préstamo. `sold_at = now()` (instante en que
    //    salió la mercancía); `sale_number` NULL (un préstamo no es venta). Se
    //    persiste `client_operation_id` para deduplicar reintentos.
    //
    //    TRADE-OFF (B1): esto SOBREESCRIBE el `client_operation_id` original con
    //    el que el pedido se creó (la llave de idempotencia de `createOrder`).
    //    El índice único parcial `uq_sale_invoices_client_operation` solo admite
    //    una llave por factura, así que la de creación se pierde. Impacto práctico
    //    NULO: un pedido ya convertido en préstamo no vuelve a "crearse" vía el
    //    POST /sales idempotente (ya existe y ya no es ORDER), y la nueva llave es
    //    la que necesitamos para deduplicar reintentos del propio préstamo.
    await manager.update(
      SaleInvoice,
      { id: sale.id, company_id: String(companyId) },
      {
        ticket_type: TicketType.LOAN,
        sold_at: new Date(),
        client_operation_id: dto.client_operation_id,
      },
    );

    // 5. Descuento de inventario, EXACTAMENTE como una venta (reason SALE):
    //    respeta el control estricto de stock; el owner puede forzar negativo
    //    con override_stock. Si el stock no alcanza y no hay override,
    //    `adjustInventory` lanza InsufficientStockError (422 INSUFFICIENT_STOCK)
    //    y la TX hace rollback (la conversión se revierte).
    const lines = await manager.find(SaleInvoiceLine, {
      where: {
        sale_invoice_id: sale.id,
        company_id: String(companyId),
      },
    });
    if (lines.length > 0) {
      const inventoryLines = lines.map((l) => ({
        item_id: Number(l.product_id),
        quantity: Number(l.quantity),
        packaging_value: l.packaging_value,
        combo_recipe: l.combo_recipe,
      }));
      // El override solo lo concede el rol owner (único que llega hasta aquí).
      const allowOverrideStock = dto.override_stock === true && actor.type === 'owner';
      await adjustInventory(manager, companyId, inventoryLines, 'DEDUCT', {
        reason: 'SALE',
        referenceType: 'sale_invoice',
        referenceId: Number(sale.id),
        referenceCode: sale.ticket_number,
        description: `Préstamo a tercero ${sale.ticket_number}`,
        overrideStock: allowOverrideStock,
        actorName: actor.fullName,
        actorUserId: actor.id,
        // Un préstamo puede incluir productos compartidos por el principal: el
        // descuento pega en la fila del dueño real (paridad con la venta).
        crossCompanyAccess: true,
      });
    }

    // 6. HISTORIAL: el pedido se convirtió en préstamo. Sin monto (no hay
    //    dinero); el actor queda como snapshot.
    await recordSaleStatus(manager, {
      companyId,
      saleInvoiceId: Number(sale.id),
      eventType: SaleStatusEventType.LOANED,
      amount: null,
      createdBy: actor.fullName,
    });

    this.logger.log({
      event: 'loan.processed',
      companyId,
      saleId: Number(sale.id),
      ticketNumber: sale.ticket_number,
      lineCount: lines.length,
      actorId: actor.id,
    });

    return {
      success: true,
      message: 'Préstamo registrado exitosamente',
      invoice_id: Number(sale.id),
      ticket_number: sale.ticket_number,
      sale_number: null,
    };
  }

  /**
   * Busca un LOAN ya registrado con esta `client_operation_id` en la company.
   * Si existe, la operación ya se procesó → replay idempotente (sin doble
   * descuento). Lectura FUERA de transacción (como el fast-path de pagos).
   */
  private async tryReplayIdempotent(
    companyId: number,
    clientOperationId: string,
  ): Promise<ProcessLoanResult | null> {
    const sale = await this.dataSource.getRepository(SaleInvoice).findOne({
      where: {
        company_id: String(companyId),
        client_operation_id: clientOperationId,
        ticket_type: TicketType.LOAN,
        is_deleted: false,
      },
      select: { id: true, ticket_number: true },
    });
    if (!sale) {
      return null;
    }
    this.logger.log({
      event: 'loan.idempotent_replay',
      companyId,
      clientOperationId,
      saleId: Number(sale.id),
    });
    return this.replayFromSale(sale);
  }

  private replayFromSale(sale: Pick<SaleInvoice, 'id' | 'ticket_number'>): ProcessLoanResult {
    return {
      success: true,
      message: 'Préstamo registrado exitosamente (reintento idempotente)',
      invoice_id: Number(sale.id),
      ticket_number: sale.ticket_number,
      sale_number: null,
      code: ERR.DUPLICATE_OPERATION,
      replay: true,
    };
  }

  private fail(message: string, code: string): ProcessLoanResult {
    return {
      success: false,
      message,
      invoice_id: null,
      ticket_number: null,
      sale_number: null,
      code,
    };
  }
}
