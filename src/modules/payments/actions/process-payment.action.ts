import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';
import { recomputeSalePoints } from '@/modules/sales/internal/customer-points.helper';
import { assertMarginAboveMinimum } from '@/modules/sales/internal/margin-guard.helper';
import { SaleCredit, SaleCreditStatus } from '@/modules/sales/entities/sale-credit.entity';
import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '@/modules/sales/entities/sale-invoice.entity';
import {
  SalePayment,
  SalePaymentMethod,
  type SalePaymentAccountType,
} from '@/modules/sales/entities/sale-payment.entity';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import {
  ProcessPaymentDto,
  ProcessPaymentMethod,
  ProcessPaymentTenderDto,
} from '../dto/process-payment.dto';

/**
 * Actor que procesa el pago (User u Employee logueado). Sólo capturamos los
 * campos que la action consume — paridad CLAUDE.md §3.1.
 */
export interface ProcessPaymentActor {
  id: number;
  fullName: string;
  /** `owner | manager | employee | superadmin`. Decide si el override_margin aplica. */
  type: string | null;
}

/**
 * Resultado de `POST /payments` — espejo byte-a-byte de `ProcessPaymentResult`
 * de PlacePos.
 *
 * El controller traduce:
 *   - `success === true`  → 201 con `{ success: true, payload: result }`.
 *   - `success === false` → 422 con
 *     `{ success: false, error: result.message, payload: { code } }`.
 *
 * La action NUNCA lanza `UnprocessableEntityException` por errores de negocio
 * (factura no existe, mismatch de montos, crédito sin cliente, margen bajo):
 * los devuelve como `{success:false, code}` para que el shape de error siga
 * idéntico al cliente local. Cualquier otra excepción inesperada SÍ se
 * propaga al filtro global (500).
 */
export interface ProcessPaymentResult {
  success: boolean;
  message: string;
  payment_id: number | null;
  /**
   * Todos los ids de SalePayment creados en este pago dividido (split tender),
   * en el mismo orden que `payments[]`. `payment_id` queda como el primero por
   * compatibilidad con el front viejo. Vacío si no hubo tender (crédito puro).
   */
  payment_ids?: number[];
  credit_id: number | null;
  /**
   * Folio SALE generado al convertir ORDER → SALE. El cliente PlacePos lo
   * lee de `result.payload.sale_number` (ver `SaleController.ts → handler
   * payment:process`). Presente solo en `success: true`.
   */
  sale_number?: string | null;
  code?: string;
  /**
   * Marca interna: `true` cuando el resultado proviene del fast-path
   * idempotente (la request es un reintento, no un nuevo procesamiento).
   * El controller usa esta marca para devolver 200 OK en lugar de 201
   * CREATED. NO forma parte del contrato HTTP — `JSON.stringify` con un
   * mapeo en el controller la elimina antes de devolver al cliente.
   */
  replay?: boolean;
}

/**
 * Códigos de error PlacePos para `POST /payments`. PlacePos los emite con el
 * mismo string — los preservamos textualmente para que el frontend pueda
 * ramificar sin diff entre modo local y cloud.
 */
const ERR = {
  INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',
  INVOICE_NOT_ORDER: 'INVOICE_NOT_ORDER',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  /** El desglose de tenders + crédito no suma `amount_due` (±0.01). */
  PAYMENT_BREAKDOWN_MISMATCH: 'PAYMENT_BREAKDOWN_MISMATCH',
  /** `payments[]` vacío o un tender con `amount_paid <= 0`. */
  INVALID_PAYMENT_ITEM: 'INVALID_PAYMENT_ITEM',
  /**
   * Vuelto inválido en un tender: `change_amount < 0`, `change_amount >
   * amount_paid` (neto negativo restaría de caja), o `change_amount > 0` en
   * TRANSFER (en transferencia no hay vuelto).
   */
  INVALID_CHANGE_AMOUNT: 'INVALID_CHANGE_AMOUNT',
  CREDIT_REQUIRES_CUSTOMER: 'CREDIT_REQUIRES_CUSTOMER',
  TRANSFER_REQUIRES_BANK: 'TRANSFER_REQUIRES_BANK',
  BANK_NOT_FOUND: 'BANK_NOT_FOUND',
  MARGIN_BELOW_MIN: 'MARGIN_BELOW_MIN',
} as const;

/**
 * Procesa un pago — espejo de `processPayment` de
 * `placepos/src/main/database/paymentOperations.ts`.
 *
 * --------------------------------------------------------------------------
 * Flujo atómico (UNA transacción, SERIALIZABLE)
 * --------------------------------------------------------------------------
 *
 *   1. Lookup `SaleInvoice` por (id, company_id, is_deleted=false) con lock
 *      pessimistic_write. Si no existe → `{success:false, code:INVOICE_NOT_FOUND}`.
 *   2. Si `ticket_type !== ORDER` → `INVOICE_NOT_ORDER` (no se re-cobra una SALE).
 *   3. Validar `|sale.total - amount_due| <= 0.01` con Big.js.
 *   4. Validar `is_credit && credit_amount>0` ⇒ `customer_id` no-null.
 *   5. Validar `payment_method=TRANSFER` ⇒ `bank_id` no-null.
 *   6. `assertMarginAboveMinimum` con `overrideMargin = dto.override_margin &&
 *      actor.type IN {owner, superadmin}`. Si la helper lanza con
 *      `payload.code=MARGIN_BELOW_MIN` la capturamos y devolvemos result.
 *   7. Generar `sale_number` (`IncrementTicketNumberAction.execute`,
 *      ticketType=SALE). UPDATE `SaleInvoice.ticket_type=SALE, sale_number`.
 *   8. `adjustInventory(... 'DEDUCT')` sobre las líneas (stub hoy).
 *   9. Si `amount_paid > 0`: INSERT `SalePayment` + side effects según método.
 *      - CASH: getOrCreate caja del actor (lock), UPDATE balance += amount_due,
 *        log CASH_RECEIVED (informativo), CASH_PAYMENT (afecta balance),
 *        CASH_CHANGE (informativo) si change_amount>0.
 *      - TRANSFER: lookup Bank con lock, UPDATE balance += amount_due,
 *        FinancialMovement INCOME / SALE.
 *      - CREDIT (puro): no aplica payment, no aplica side effect.
 *  10. Si `is_credit && credit_amount > 0`: INSERT `SaleCredit`.
 *  11. UPDATE final `SaleInvoice` (paid/balance lo dejamos coherente con la
 *      semántica PlacePos — ver nota abajo).
 *
 * --------------------------------------------------------------------------
 * Sobre las columnas `paid` y `balance` en `SaleInvoice`
 * --------------------------------------------------------------------------
 *
 * El espejo PlacePos en este repo NO declara aún columnas `paid`/`balance` en
 * `sale_invoices`. El `SaleCredit.balance` mantiene esa información para
 * ventas a crédito y los pagos quedan reflejados en `sale_payments`. La
 * action **no** intenta escribir columnas inexistentes — preservamos paridad
 * de comportamiento sin desviarnos del esquema.
 *
 * --------------------------------------------------------------------------
 * Aislamiento
 * --------------------------------------------------------------------------
 *
 * Transacción SERIALIZABLE (CLAUDE.md §9.4): el flujo combina lock pesimista
 * sobre la venta + mutación de varios balances (banco/caja) + folio atómico.
 * SERIALIZABLE protege contra anomalías de lectura no-repetible cuando dos
 * cobros llegan a la misma venta en paralelo.
 */
@Injectable()
export class ProcessPaymentAction {
  private readonly logger = new Logger(ProcessPaymentAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly incrementTicketNumberAction: IncrementTicketNumberAction,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    dto: ProcessPaymentDto,
    companyId: number,
    actor: ProcessPaymentActor,
    idempotencyKey?: string | null,
  ): Promise<ProcessPaymentResult> {
    // 0. Enforcement early de `override_margin`. Solo `owner | superadmin`
    //    pueden activar la flag. Un `manager` que la envíe recibe 403 ANTES
    //    de abrir transacción — fail-fast con código explícito. El guard
    //    interno `assertMarginAboveMinimum` sigue siendo la defensa final,
    //    pero queremos rechazar la intención maliciosa cuanto antes.
    if (dto.override_margin === true && actor.type !== 'owner' && actor.type !== 'superadmin') {
      throw new ForbiddenException({
        message: 'Solo el dueño puede forzar el override de margen mínimo.',
        payload: { code: 'OVERRIDE_NOT_ALLOWED' },
      });
    }

    // 0.5. Fast-path Idempotency-Key (HIGH-3): si el cliente envía
    //      `Idempotency-Key` y ya existe un SalePayment con ese uuid en la
    //      misma company, devolvemos el resultado anterior SIN abrir
    //      transacción. Evita doble cobro por reintento de red. El UNIQUE
    //      `(company_id, uuid)` sobre `sale_payments` garantiza unicidad si
    //      dos requests llegan en paralelo: la segunda fallará en el INSERT
    //      y caerá al wrapper `catch` (que la mapea a result con código).
    if (idempotencyKey) {
      const replay = await this.tryReplayIdempotent(companyId, idempotencyKey);
      if (replay) {
        return replay;
      }
    }

    // TypeORM 0.3 acepta `IsolationLevel` como primer argumento de
    // `dataSource.transaction(isolation, runInTransaction)`. SERIALIZABLE
    // ejecuta `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` en el conector
    // PG (driver pg) — equivalente al SQL manual y más portable.
    try {
      return await this.dataSource.transaction<ProcessPaymentResult>(
        'SERIALIZABLE',
        async (manager) => this.run(manager, dto, companyId, actor, idempotencyKey ?? null),
      );
    } catch (error) {
      // Reglas de negocio que abortaron la TX después de mutar estado (ej.
      // BANK_NOT_FOUND tras generar folio): el rollback ya rehizo el folio,
      // pero seguimos contractualmente devolviendo `{success:false, code}`.
      if (error instanceof BusinessRuleError) {
        this.logger.warn({
          event: 'payment.business_rule_error',
          code: error.code,
          message: error.message,
          companyId,
          invoiceId: dto.invoice_id,
        });
        return this.fail(error.message, error.code);
      }
      throw error;
    }
  }

  private async run(
    manager: EntityManager,
    dto: ProcessPaymentDto,
    companyId: number,
    actor: ProcessPaymentActor,
    idempotencyKey: string | null,
  ): Promise<ProcessPaymentResult> {
    // 1. Lookup venta con lock pessimistic_write.
    const sale = await manager.findOne(SaleInvoice, {
      where: {
        id: String(dto.invoice_id),
        company_id: String(companyId),
        is_deleted: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!sale) {
      return this.fail('Factura no encontrada', ERR.INVOICE_NOT_FOUND);
    }

    // 2. Solo ORDER es procesable.
    if (sale.ticket_type !== TicketType.ORDER) {
      return this.fail('Solo se pueden procesar pagos de pedidos (ORDER)', ERR.INVOICE_NOT_ORDER);
    }

    // 3. Match total ↔ amount_due (±0.01 Big.js).
    const totalBig = toBig(sale.total);
    const amountDueBig = toBig(dto.amount_due);
    if (totalBig.minus(amountDueBig).abs().gt(toBig(0.01))) {
      return this.fail('El monto del ticket no coincide con el monto enviado', ERR.AMOUNT_MISMATCH);
    }

    // 3.5. Normalizar tenders. El front nuevo manda `payments[]`; los callers
    //      viejos mandan el shape plano (`payment_method`/`amount_paid`/...).
    //      `normalizeTenders` unifica ambos a un array de tenders.
    const tenders = this.normalizeTenders(dto);

    // Remanente a crédito (0 si la venta no es a crédito). Se calcula aquí
    // porque también decide si se permiten 0 tenders (venta 100% a crédito).
    const creditAmountBig = dto.is_credit ? toBig(dto.credit_amount) : toBig(0);

    // 4. Validaciones de tenders:
    //    a) debe haber al menos un tender, SALVO venta 100% a crédito: 0 tenders
    //       es legítimo (el remanente lo cubre el SaleCredit). El invariante de
    //       cuadre (paso 5) verifica que credit_amount = amount_due en ese caso.
    if (tenders.length === 0 && !creditAmountBig.gt(0)) {
      return this.fail('Debe enviar al menos un método de pago', ERR.INVALID_PAYMENT_ITEM);
    }
    //    b) cada tender con amount_paid > 0, vuelto coherente y TRANSFER con
    //       bank_id.
    for (const tender of tenders) {
      const amountPaidBig = toBig(tender.amount_paid);
      const changeBig = toBig(tender.change_amount ?? 0);
      if (!amountPaidBig.gt(0)) {
        return this.fail(
          'Cada método de pago debe tener un monto mayor a cero',
          ERR.INVALID_PAYMENT_ITEM,
        );
      }
      // Vuelto: no negativo y nunca mayor que lo entregado (neto negativo
      // RESTARÍA de caja). Validamos en runtime aunque el DTO ya tenga Min(0):
      // el shape plano legado o un caller no-DTO podrían saltarse el pipe.
      if (changeBig.lt(0)) {
        return this.fail('El vuelto no puede ser negativo', ERR.INVALID_CHANGE_AMOUNT);
      }
      if (changeBig.gt(amountPaidBig)) {
        return this.fail(
          'El vuelto no puede ser mayor que el monto entregado',
          ERR.INVALID_CHANGE_AMOUNT,
        );
      }
      // En transferencia NO hay vuelto: rechazamos change>0 para no divergir
      // del cuadre ni de placepos (que acredita el banco por el neto).
      if (tender.payment_method === ProcessPaymentMethod.TRANSFER && changeBig.gt(0)) {
        return this.fail('El pago por transferencia no admite vuelto', ERR.INVALID_CHANGE_AMOUNT);
      }
      if (tender.payment_method === ProcessPaymentMethod.TRANSFER && !tender.bank_id) {
        return this.fail(
          'El pago por transferencia requiere un banco receptor',
          ERR.TRANSFER_REQUIRES_BANK,
        );
      }
    }

    // 5. Invariante de cuadre (HOT PATH): el neto de tenders (entregado menos
    //    vuelto) + el remanente a crédito debe igualar `amount_due` (±0.01).
    //    Σ(amount_paid − change_amount) + credit_amount ≈ amount_due.
    const tenderNetBig = tenders.reduce(
      (acc, t) => acc.plus(toBig(t.amount_paid).minus(toBig(t.change_amount ?? 0))),
      toBig(0),
    );
    const breakdownTotal = tenderNetBig.plus(creditAmountBig);
    if (breakdownTotal.minus(amountDueBig).abs().gt(toBig(0.01))) {
      return this.fail(
        'El desglose de pagos no coincide con el total de la venta',
        ERR.PAYMENT_BREAKDOWN_MISMATCH,
      );
    }

    // 6. Crédito requiere customer.
    if (dto.is_credit && creditAmountBig.gt(0) && !sale.customer_id) {
      return this.fail(
        'No se puede registrar crédito sin un cliente asignado a la factura',
        ERR.CREDIT_REQUIRES_CUSTOMER,
      );
    }

    // 6. Margen mínimo. El override solo lo concede el helper si el rol
    //    pertenece al set OVERRIDE_ROLES (owner / superadmin); aquí solo
    //    propagamos la solicitud.
    try {
      await assertMarginAboveMinimum({
        manager,
        companyId,
        total: sale.total,
        cost: sale.cost,
        overrideMargin: dto.override_margin === true,
        userType: actor.type,
        messagePrefix: 'El margen de la venta',
      });
    } catch (error) {
      // Re-empaquetar como result si fue el code conocido — paridad PlacePos.
      const marginCode = this.extractMarginCode(error);
      if (marginCode !== null) {
        return this.fail(this.extractMessage(error), marginCode);
      }
      throw error;
    }

    // 7. Folio SALE atómico + UPDATE de la venta.
    const folio = await this.incrementTicketNumberAction.execute(
      manager,
      companyId,
      TicketSettingType.SALE,
    );
    await manager.update(
      SaleInvoice,
      { id: sale.id, company_id: String(companyId) },
      {
        ticket_type: TicketType.SALE,
        sale_number: folio.formatted,
      },
    );

    // 8. Ajuste de inventario sobre líneas. Decrementa Product.stock y
    //    persiste una fila en inventory_movements por cada producto afectado
    //    (reason=SALE, reference_type=sale_invoice). El helper aborta con
    //    InsufficientStockError (422) si el descuento dejaría stock negativo
    //    y no llegó override.
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
      }));
      // Paridad PlacePos: el override_stock solo lo concede el rol del actor.
      // Si un employee/manager envía la flag, se ignora silenciosamente — el
      // adjustInventory entonces fallará con InsufficientStockError si el
      // stock no alcanza, igual que en placepos.
      const allowOverrideStock =
        dto.override_stock === true && (actor.type === 'owner' || actor.type === 'superadmin');
      await adjustInventory(manager, companyId, inventoryLines, 'DEDUCT', {
        reason: 'SALE',
        referenceType: 'sale_invoice',
        referenceId: Number(sale.id),
        referenceCode: folio.formatted,
        description: `Venta ${folio.formatted}`,
        overrideStock: allowOverrideStock,
        actorName: actor.fullName,
        actorUserId: actor.id,
        // FASE 2 (COMPARTIR): la venta puede incluir productos compartidos por el
        // principal. El descuento de stock debe pegar en la fila del DUEÑO real
        // (el principal), no en la sucursal. Un producto NO accesible para la
        // company activa sigue rechazado (set accesible = propios + compartidos).
        crossCompanyAccess: true,
      });
    }

    // 9. SalePayment + side effects POR CADA tender. El override/margen/stock
    //    se aplicó UNA sola vez arriba (a nivel venta), no por pago.
    //
    //    uuid por pago (idempotencia a nivel operación): el tender 0 usa la
    //    llave de operación "pura" (`idempotencyKey`) para que
    //    `tryReplayIdempotent` lo encuentre en un reintento; los siguientes
    //    derivan `${idempotencyKey}:${i}`. Así el UNIQUE (company_id, uuid)
    //    deduplica TODO el split: si la operación se reintenta, el primer
    //    INSERT colisiona y el fast-path devuelve el resultado previo. Sin
    //    `idempotencyKey` (caller sin llave) cada pago lleva `uuid=null`.
    const paymentIds: number[] = [];
    for (let i = 0; i < tenders.length; i += 1) {
      const tender = tenders[i];
      const tenderUuid = this.deriveTenderUuid(idempotencyKey, i);
      const inserted = await this.insertPaymentAndApplySideEffects(
        manager,
        tender,
        sale,
        companyId,
        actor,
        folio.formatted,
        tenderUuid,
      );
      paymentIds.push(inserted.paymentId);
    }
    const paymentId: number | null = paymentIds.length > 0 ? paymentIds[0] : null;

    // 10. SaleCredit por el remanente (igual que hoy; el monto ya viene
    //     calculado por el front en `credit_amount`).
    let creditId: number | null = null;
    if (dto.is_credit && creditAmountBig.gt(0)) {
      creditId = await this.insertCredit(manager, dto, sale, companyId);
    }

    // 11. PUNTOS de cliente (solo CONTADO). La venta acaba de constituirse
    //     (ticket_type=SALE) y el SaleCredit por el remanente ya existe. El
    //     recompute idempotente otorga puntos sobre la base de contado
    //     (`totalConsolidado − creditPrincipal`); si la config está off o no
    //     hay cliente, no-op. Dentro de la MISMA TX SERIALIZABLE.
    await recomputeSalePoints(manager, Number(sale.id), companyId);

    this.logger.log({
      event: 'payment.processed',
      companyId,
      saleId: Number(sale.id),
      saleNumber: folio.formatted,
      tenderCount: tenders.length,
      tenderNet: preciseNumber(tenderNetBig, 2),
      creditAmount: preciseNumber(creditAmountBig, 2),
      paymentIds,
      creditId,
      actorId: actor.id,
    });

    return {
      success: true,
      message: 'Pago procesado exitosamente',
      payment_id: paymentId,
      payment_ids: paymentIds,
      credit_id: creditId,
      sale_number: folio.formatted,
    };
  }

  /**
   * Normaliza el payload a un array de tenders. Si el front nuevo envía
   * `payments[]` lo usa tal cual. Si no llega (caller legado), reconstruye un
   * único tender desde los campos planos (`payment_method`/`amount_paid`/...).
   *
   * RETROCOMPAT: un caller viejo que mandaba `payment_method=CREDIT` con
   * `amount_paid=0` (crédito puro) produce un tender con monto 0 que el front
   * nuevo nunca enviaría; ese tender se descarta aquí porque no aporta dinero
   * (el crédito ya se maneja con `is_credit`/`credit_amount`). El array
   * resultante puede quedar vacío en ese caso → crédito puro sin tender.
   */
  private normalizeTenders(dto: ProcessPaymentDto): ProcessPaymentTenderDto[] {
    if (Array.isArray(dto.payments) && dto.payments.length > 0) {
      return dto.payments;
    }
    // Shape plano legado.
    if (dto.payment_method && toBig(dto.amount_paid ?? 0).gt(0)) {
      // CREDIT plano con amount_paid>0: paridad con la rama defensiva previa
      // (se trataba como CASH). Aquí lo normalizamos a CASH explícitamente.
      const method =
        dto.payment_method === ProcessPaymentMethod.TRANSFER
          ? ProcessPaymentMethod.TRANSFER
          : ProcessPaymentMethod.CASH;
      return [
        {
          payment_method: method,
          amount_paid: dto.amount_paid ?? 0,
          change_amount: dto.change_amount ?? 0,
          bank_id: dto.bank_id ?? null,
          bank_name: dto.bank_name ?? null,
        },
      ];
    }
    return [];
  }

  /**
   * Deriva el uuid idempotente de un tender. El primer pago (i=0) usa la llave
   * de operación pura para que el fast-path `tryReplayIdempotent` (que busca
   * por `uuid = idempotencyKey`) lo encuentre. Los pagos siguientes derivan
   * `${idempotencyKey}:${i}`. Sin llave de operación, devuelve `null`.
   */
  private deriveTenderUuid(idempotencyKey: string | null, index: number): string | null {
    if (!idempotencyKey) {
      return null;
    }
    return index === 0 ? idempotencyKey : `${idempotencyKey}:${index}`;
  }

  // ------------------------------------------------------------------------
  // INSERT SalePayment + side effects por método
  // ------------------------------------------------------------------------

  private async insertPaymentAndApplySideEffects(
    manager: EntityManager,
    tender: ProcessPaymentTenderDto,
    sale: SaleInvoice,
    companyId: number,
    actor: ProcessPaymentActor,
    saleNumber: string,
    tenderUuid: string | null,
  ): Promise<{ paymentId: number }> {
    if (tender.payment_method === ProcessPaymentMethod.TRANSFER) {
      return this.applyTransfer(manager, tender, sale, companyId, actor, saleNumber, tenderUuid);
    }
    // CASH (y cualquier valor inesperado se trata como efectivo, paridad con la
    // rama defensiva previa). El CREDIT como tender ya se descartó en
    // `normalizeTenders` (el crédito vive en `is_credit`/`credit_amount`).
    return this.applyCash(manager, tender, sale, companyId, actor, saleNumber, tenderUuid);
  }

  /**
   * CASH (un tender):
   *   - Insert SalePayment(method=CASH, account_type=cash_register).
   *   - UPDATE caja.balance += neto del tender (amount_paid − change_amount):
   *     lo que la caja gana por ESTE tender, NO el total de la venta. En split
   *     tender cada pago aporta su neto; en pago único total el neto iguala
   *     `amount_due` (equivalencia con el comportamiento anterior).
   *   - Log CASH_RECEIVED (IN, affects_balance=false): efectivo recibido del
   *     cliente por este tender (informativo, igual amount_paid).
   *   - Log CASH_PAYMENT  (IN, affects_balance=true) : neto que la caja gana
   *     por este tender.
   *   - Log CASH_CHANGE   (OUT, affects_balance=false): vuelto al cliente
   *     (sólo si change_amount > 0).
   */
  private async applyCash(
    manager: EntityManager,
    tender: ProcessPaymentTenderDto,
    sale: SaleInvoice,
    companyId: number,
    actor: ProcessPaymentActor,
    saleNumber: string,
    tenderUuid: string | null,
  ): Promise<{ paymentId: number }> {
    const amountPaidBig = toBig(tender.amount_paid);
    const changeBig = toBig(tender.change_amount ?? 0);
    const amountPaid = preciseNumber(amountPaidBig, 2);
    const change = preciseNumber(changeBig, 2);
    // Neto del tender = entregado − vuelto. Es lo que realmente queda en caja.
    const netBig = amountPaidBig.minus(changeBig);
    const net = preciseNumber(netBig, 2);

    const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);

    // INSERT SalePayment (account_type='cash_register', account_id=register.id).
    const payment = manager.create(SalePayment, {
      company_id: String(companyId),
      sale_invoice_id: sale.id,
      payment_method: SalePaymentMethod.CASH,
      amount: amountPaid,
      change_amount: change,
      bank_id: null,
      bank_name: null,
      account_type: 'cash_register' satisfies SalePaymentAccountType,
      account_id: register.id,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
      uuid: tenderUuid,
    });
    const savedPayment = await manager.save(SalePayment, payment);
    const paymentId = Number(savedPayment.id);

    // UPDATE caja.balance += neto del tender. Mismo cálculo que PlacePos
    // (registerCashPayment con affectsBalance=true, dirección IN).
    const newBalance = preciseNumber(toBig(register.balance).plus(netBig), 2);
    await manager.update(
      CashRegister,
      { id: register.id, company_id: String(companyId) },
      { balance: newBalance },
    );

    // Logs (paridad PlacePos):
    //   1. CASH_RECEIVED — IN, affects_balance=false, amount=amount_paid.
    if (amountPaid > 0) {
      await this.insertCashLog(manager, {
        companyId,
        cashRegisterId: register.id,
        type: CashRegisterLogType.CASH_RECEIVED,
        direction: 'IN',
        amount: amountPaid,
        affectsBalance: false,
        description: `Efectivo recibido del cliente - Venta #${saleNumber}`,
        invoiceId: Number(sale.id),
        paymentId,
        actor,
      });
    }

    //   2. CASH_PAYMENT  — IN, affects_balance=true, amount=neto del tender.
    if (net > 0) {
      await this.insertCashLog(manager, {
        companyId,
        cashRegisterId: register.id,
        type: CashRegisterLogType.CASH_PAYMENT,
        direction: 'IN',
        amount: net,
        affectsBalance: true,
        description: `Pago de venta - Venta #${saleNumber}`,
        invoiceId: Number(sale.id),
        paymentId,
        actor,
      });
    }

    //   3. CASH_CHANGE   — OUT, affects_balance=false, amount=change_amount.
    if (change > 0) {
      await this.insertCashLog(manager, {
        companyId,
        cashRegisterId: register.id,
        type: CashRegisterLogType.CASH_CHANGE,
        direction: 'OUT',
        amount: change,
        affectsBalance: false,
        description: `Devueltas al cliente - Venta #${saleNumber}`,
        invoiceId: Number(sale.id),
        paymentId,
        actor,
      });
    }

    return { paymentId };
  }

  /**
   * TRANSFER (un tender):
   *   - Lookup Bank (lock pessimistic_write, valida ownership multi-tenant).
   *   - Insert SalePayment(method=TRANSFER, account_type=bank).
   *   - UPDATE bank.balance += amount_paid del tender (en TRANSFER el vuelto
   *     siempre es 0, así que el monto del tender es su neto).
   *   - FinancialMovement(INCOME, SALE, destination=bank) por el monto del
   *     tender.
   */
  private async applyTransfer(
    manager: EntityManager,
    tender: ProcessPaymentTenderDto,
    sale: SaleInvoice,
    companyId: number,
    actor: ProcessPaymentActor,
    saleNumber: string,
    tenderUuid: string | null,
  ): Promise<{ paymentId: number }> {
    // bank_id ya validado no-null en `run()`.
    const bankId = tender.bank_id as number;

    const bank = await manager.findOne(Bank, {
      where: {
        id: String(bankId),
        company_id: String(companyId),
        is_archived: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bank) {
      // Lookup falla → result 422 BANK_NOT_FOUND. Lanzamos para que el catch
      // de transaction haga rollback y propagamos al controller vía throw.
      // Pero la convención es "no throw para errores de negocio": usamos un
      // throw interno especial que el wrapper de execute() convierte. Más
      // simple: aceptamos el rollback y devolvemos el result; el throw aquí
      // detiene la transacción para que el folio NO se queme.
      throw new BusinessRuleError('Cuenta bancaria no encontrada', ERR.BANK_NOT_FOUND);
    }

    const amountPaidBig = toBig(tender.amount_paid);
    const amountPaid = preciseNumber(amountPaidBig, 2);
    // En TRANSFER no hay vuelto (ya rechazado en la validación de tenders); lo
    // persistimos a 0 por contrato. El NETO acreditado = amount_paid − change,
    // que aquí siempre iguala amount_paid, pero lo calculamos por defensa para
    // que el banco/FinancialMovement NUNCA divergan del cuadre ni de placepos.
    const changeBig = toBig(tender.change_amount ?? 0);
    const netBig = amountPaidBig.minus(changeBig);
    const net = preciseNumber(netBig, 2);

    // INSERT SalePayment. `change_amount` siempre 0 en TRANSFER por contrato.
    const payment = manager.create(SalePayment, {
      company_id: String(companyId),
      sale_invoice_id: sale.id,
      payment_method: SalePaymentMethod.TRANSFER,
      amount: amountPaid,
      change_amount: 0,
      bank_id: bank.id,
      bank_name: bank.name,
      account_type: 'bank' satisfies SalePaymentAccountType,
      account_id: bank.id,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
      uuid: tenderUuid,
    });
    const savedPayment = await manager.save(SalePayment, payment);
    const paymentId = Number(savedPayment.id);

    // UPDATE bank.balance += neto del tender.
    const newBalance = preciseNumber(toBig(bank.balance).plus(netBig), 2);
    await manager.update(
      Bank,
      { id: bank.id, company_id: String(companyId) },
      { balance: newBalance },
    );

    // FinancialMovement INCOME / SALE.
    const customerIdNum =
      sale.customer_id !== null && sale.customer_id !== undefined ? Number(sale.customer_id) : null;
    const sourceFields =
      customerIdNum !== null
        ? { source_type: 'external' as const, source_id: customerIdNum }
        : { source_type: null, source_id: null };
    await this.financialMovementsService.record(manager, {
      companyId,
      amount: net,
      movement_type: MovementType.INCOME,
      // Paridad PlacePos: `paymentOperations.ts` emite `SALE_PAYMENT`. El enum
      // tiene SALE_PAYMENT activo desde la migración 1747010460000.
      concept: MovementConcept.SALE_PAYMENT,
      description: `Pago por transferencia - Venta ${saleNumber}`,
      ...sourceFields,
      destination_type: 'bank',
      destination_id: Number(bank.id),
      reference_code: `SALE-${saleNumber}`,
      created_by: actor.fullName,
      created_by_id: actor.id,
    });

    return { paymentId };
  }

  // ------------------------------------------------------------------------
  // SaleCredit
  // ------------------------------------------------------------------------

  private async insertCredit(
    manager: EntityManager,
    dto: ProcessPaymentDto,
    sale: SaleInvoice,
    companyId: number,
  ): Promise<number> {
    // sale.customer_id ya validado no-null en `run()`.
    const creditAmount = preciseNumber(toBig(dto.credit_amount), 2);
    const dueDate = dto.due_date ? new Date(dto.due_date) : null;

    const credit = manager.create(SaleCredit, {
      company_id: String(companyId),
      sale_invoice_id: sale.id,
      customer_id: sale.customer_id as string,
      total_amount: creditAmount,
      paid_amount: 0,
      balance: creditAmount,
      due_date: dueDate,
      status: SaleCreditStatus.PENDING,
    });
    const saved = await manager.save(SaleCredit, credit);
    return Number(saved.id);
  }

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  private async insertCashLog(
    manager: EntityManager,
    args: {
      companyId: number;
      cashRegisterId: string;
      type: CashRegisterLogType;
      direction: 'IN' | 'OUT';
      amount: number;
      affectsBalance: boolean;
      description: string;
      invoiceId: number | null;
      paymentId: number | null;
      actor: ProcessPaymentActor;
    },
  ): Promise<void> {
    const log = manager.create(CashRegisterLog, {
      company_id: String(args.companyId),
      cash_register_id: args.cashRegisterId,
      type: args.type,
      direction: args.direction,
      amount: args.amount,
      affects_balance: args.affectsBalance,
      description: args.description,
      created_by: args.actor.fullName,
      created_by_id: String(args.actor.id),
      invoice_id: args.invoiceId !== null ? String(args.invoiceId) : null,
      payment_id: args.paymentId !== null ? String(args.paymentId) : null,
      credit_note_id: null,
      is_credit_related: false,
    });
    await manager.save(CashRegisterLog, log);
  }

  /**
   * Fast-path Idempotency-Key (HIGH-3): si la company ya procesó un pago con
   * este uuid, devolvemos el mismo `ProcessPaymentResult` sin abrir nueva
   * transacción. Reconstruye el payload mínimo PlacePos: `{payment_id,
   * credit_id, sale_number, message}`.
   *
   * Multi-tenant: filtra por `(company_id, uuid)` — el UNIQUE garantiza que
   * solo encuentra rows de la propia company.
   */
  private async tryReplayIdempotent(
    companyId: number,
    idempotencyKey: string,
  ): Promise<ProcessPaymentResult | null> {
    // El tender 0 del split usa la llave de operación pura → ese row ancla el
    // replay. Si existe, la operación completa ya se procesó (toda en una TX).
    const payment = await this.dataSource.getRepository(SalePayment).findOne({
      where: { company_id: String(companyId), uuid: idempotencyKey },
    });
    if (!payment) {
      return null;
    }
    // Recuperar los pagos VIVOS del sale_invoice — en split tender hay varios.
    // Excluimos pagos reversados (is_voided) para no devolver en el replay un
    // payment_id que ya fue anulado por la feature de reverso.
    // Orden por id ASC para devolver `payment_ids` en el mismo orden de
    // inserción (tender 0 primero), consistente con el primer procesamiento.
    const payments = await this.dataSource.getRepository(SalePayment).find({
      where: {
        company_id: String(companyId),
        sale_invoice_id: payment.sale_invoice_id,
        is_voided: false,
      },
      order: { id: 'ASC' },
      select: { id: true },
    });
    const paymentIds = payments.map((p) => Number(p.id));
    // Recuperar credit asociado al sale_invoice (puede no existir).
    const credit = await this.dataSource.getRepository(SaleCredit).findOne({
      where: {
        company_id: String(companyId),
        sale_invoice_id: payment.sale_invoice_id,
      },
    });
    // Re-leer `sale_number` de la venta para devolverlo en la respuesta
    // idempotente — el cliente PlacePos lo necesita en ambos paths (primer
    // intento y replay) para imprimir el ticket con el folio correcto.
    const sale = await this.dataSource.getRepository(SaleInvoice).findOne({
      where: {
        company_id: String(companyId),
        id: payment.sale_invoice_id,
      },
      select: { id: true, sale_number: true },
    });
    this.logger.log({
      event: 'payment.idempotent_replay',
      companyId,
      idempotencyKey,
      paymentIds,
    });
    return {
      success: true,
      message: 'Pago procesado exitosamente (reintento idempotente)',
      payment_id: paymentIds.length > 0 ? paymentIds[0] : Number(payment.id),
      payment_ids: paymentIds,
      credit_id: credit ? Number(credit.id) : null,
      sale_number: sale?.sale_number ?? null,
      replay: true,
    };
  }

  private fail(message: string, code: string): ProcessPaymentResult {
    return {
      success: false,
      message,
      payment_id: null,
      credit_id: null,
      code,
    };
  }

  /**
   * Si el helper de margen lanzó `UnprocessableEntityException` con
   * `payload.code = MARGIN_BELOW_MIN`, extraemos el código. Cualquier otra
   * excepción retorna `null` y se re-lanza al filtro global.
   */
  private extractMarginCode(error: unknown): string | null {
    if (
      typeof error === 'object' &&
      error !== null &&
      'getResponse' in error &&
      typeof (error as { getResponse: () => unknown }).getResponse === 'function'
    ) {
      const raw = (error as { getResponse: () => unknown }).getResponse();
      if (raw && typeof raw === 'object') {
        const obj = raw as { payload?: { code?: string }; code?: string };
        const code = obj.payload?.code ?? obj.code;
        if (code === ERR.MARGIN_BELOW_MIN) {
          return ERR.MARGIN_BELOW_MIN;
        }
      }
    }
    return null;
  }

  private extractMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
      if (
        'getResponse' in error &&
        typeof (error as { getResponse: () => unknown }).getResponse === 'function'
      ) {
        const raw = (error as { getResponse: () => unknown }).getResponse();
        if (raw && typeof raw === 'object') {
          const obj = raw as { message?: string };
          if (typeof obj.message === 'string') {
            return obj.message;
          }
        }
      }
      if ('message' in error && typeof error.message === 'string') {
        return (error as { message: string }).message;
      }
    }
    return 'Error desconocido';
  }
}

/**
 * Error interno usado para abortar la transacción cuando un lookup multi-
 * tenant falla DESPUÉS de haber generado folio / mutado el SaleInvoice. El
 * controller lo captura y lo traduce a result `{success:false, code}` para
 * preservar el shape de PlacePos.
 *
 * Esta clase es un wrapper, NO una `HttpException`: no queremos que el
 * `AllExceptionsFilter` lo formatee él mismo — el controller debe ramificar
 * sobre `result.success` y lanzar el 422 con `payload.code` adecuado.
 */
export class BusinessRuleError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'BusinessRuleError';
  }
}
