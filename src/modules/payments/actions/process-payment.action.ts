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

import { ProcessPaymentDto, ProcessPaymentMethod } from '../dto/process-payment.dto';

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
  credit_id: number | null;
  code?: string;
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

    // 4. Crédito requiere customer.
    if (dto.is_credit && toBig(dto.credit_amount).gt(0) && !sale.customer_id) {
      return this.fail(
        'No se puede registrar crédito sin un cliente asignado a la factura',
        ERR.CREDIT_REQUIRES_CUSTOMER,
      );
    }

    // 5. TRANSFER requiere bank_id.
    if (dto.payment_method === ProcessPaymentMethod.TRANSFER && !dto.bank_id) {
      return this.fail(
        'El pago por transferencia requiere un banco receptor',
        ERR.TRANSFER_REQUIRES_BANK,
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

    // 8. Ajuste de inventario sobre líneas. El helper hoy es stub pero el
    //    contrato del caller queda idéntico para cuando aterrice
    //    `Product.stock` (Fase 3+).
    const lines = await manager.find(SaleInvoiceLine, {
      where: {
        sale_invoice_id: sale.id,
        company_id: String(companyId),
      },
    });
    if (lines.length > 0) {
      // PlacePos hace `adjustInventory(manager, lines, 'DEDUCT')` — el helper
      // espejo expone (manager, companyId, lines, 'DEDUCT'). Mapeamos el
      // shape `{item_id, quantity}` desde `product_id`/`quantity` de las
      // líneas (en pos_api la columna se llama `product_id`, no `item_id`).
      const inventoryLines = lines.map((l) => ({
        item_id: Number(l.product_id),
        quantity: Number(l.quantity),
      }));
      await this.deductInventory(manager, companyId, inventoryLines);
    }

    // 9. SalePayment + side effects (solo si amount_paid > 0).
    let paymentId: number | null = null;
    const amountPaidBig = toBig(dto.amount_paid);
    if (amountPaidBig.gt(0)) {
      const inserted = await this.insertPaymentAndApplySideEffects(
        manager,
        dto,
        sale,
        companyId,
        actor,
        folio.formatted,
        idempotencyKey,
      );
      paymentId = inserted.paymentId;
    }

    // 10. SaleCredit si aplica.
    let creditId: number | null = null;
    if (dto.is_credit && toBig(dto.credit_amount).gt(0)) {
      creditId = await this.insertCredit(manager, dto, sale, companyId);
    }

    this.logger.log({
      event: 'payment.processed',
      companyId,
      saleId: Number(sale.id),
      saleNumber: folio.formatted,
      paymentMethod: dto.payment_method,
      amountPaid: preciseNumber(amountPaidBig, 2),
      paymentId,
      creditId,
      actorId: actor.id,
    });

    return {
      success: true,
      message: 'Pago procesado exitosamente',
      payment_id: paymentId,
      credit_id: creditId,
    };
  }

  // ------------------------------------------------------------------------
  // INSERT SalePayment + side effects por método
  // ------------------------------------------------------------------------

  private async insertPaymentAndApplySideEffects(
    manager: EntityManager,
    dto: ProcessPaymentDto,
    sale: SaleInvoice,
    companyId: number,
    actor: ProcessPaymentActor,
    saleNumber: string,
    idempotencyKey: string | null,
  ): Promise<{ paymentId: number }> {
    if (dto.payment_method === ProcessPaymentMethod.CASH) {
      return this.applyCash(manager, dto, sale, companyId, actor, saleNumber, idempotencyKey);
    }
    if (dto.payment_method === ProcessPaymentMethod.TRANSFER) {
      return this.applyTransfer(manager, dto, sale, companyId, actor, saleNumber, idempotencyKey);
    }
    // CREDIT puro NO debería entrar aquí (amount_paid > 0 ya filtrado en run()).
    // Defensa: si el cliente envía CREDIT con amount_paid > 0, lo tratamos como
    // entrega de efectivo a la caja del actor (paridad PlacePos: el frontend
    // jamás envía esta combinación; pero documentamos la rama).
    return this.applyCash(manager, dto, sale, companyId, actor, saleNumber, idempotencyKey);
  }

  /**
   * CASH:
   *   - Insert SalePayment(method=CASH, account_type=cash_register).
   *   - UPDATE caja.balance += amount_due (lo que la venta gana, NO el
   *     amount_paid: el change_amount se devuelve al cliente).
   *   - Log CASH_RECEIVED (IN, affects_balance=false): efectivo recibido del
   *     cliente (informativo, igual amount_paid).
   *   - Log CASH_PAYMENT  (IN, affects_balance=true) : neto que la caja gana
   *     por la venta (amount_due).
   *   - Log CASH_CHANGE   (OUT, affects_balance=false): vuelto al cliente
   *     (sólo si change_amount > 0).
   */
  private async applyCash(
    manager: EntityManager,
    dto: ProcessPaymentDto,
    sale: SaleInvoice,
    companyId: number,
    actor: ProcessPaymentActor,
    saleNumber: string,
    idempotencyKey: string | null,
  ): Promise<{ paymentId: number }> {
    const amountDueBig = toBig(dto.amount_due);
    const amountPaid = preciseNumber(toBig(dto.amount_paid), 2);
    const change = preciseNumber(toBig(dto.change_amount), 2);

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
      uuid: idempotencyKey,
    });
    const savedPayment = await manager.save(SalePayment, payment);
    const paymentId = Number(savedPayment.id);

    // UPDATE caja.balance += amount_due. Mismo cálculo que PlacePos
    // (registerCashPayment con affectsBalance=true, dirección IN).
    const newBalance = preciseNumber(toBig(register.balance).plus(amountDueBig), 2);
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

    //   2. CASH_PAYMENT  — IN, affects_balance=true, amount=amount_due.
    const amountDue = preciseNumber(amountDueBig, 2);
    if (amountDue > 0) {
      await this.insertCashLog(manager, {
        companyId,
        cashRegisterId: register.id,
        type: CashRegisterLogType.CASH_PAYMENT,
        direction: 'IN',
        amount: amountDue,
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
   * TRANSFER:
   *   - Lookup Bank (lock pessimistic_write, valida ownership multi-tenant).
   *   - Insert SalePayment(method=TRANSFER, account_type=bank).
   *   - UPDATE bank.balance += amount_due.
   *   - FinancialMovement(INCOME, SALE, destination=bank).
   */
  private async applyTransfer(
    manager: EntityManager,
    dto: ProcessPaymentDto,
    sale: SaleInvoice,
    companyId: number,
    actor: ProcessPaymentActor,
    saleNumber: string,
    idempotencyKey: string | null,
  ): Promise<{ paymentId: number }> {
    // bank_id ya validado no-null en `run()`.
    const bankId = dto.bank_id as number;

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

    const amountDueBig = toBig(dto.amount_due);
    const amountPaid = preciseNumber(toBig(dto.amount_paid), 2);
    const change = preciseNumber(toBig(dto.change_amount), 2);

    // INSERT SalePayment.
    const payment = manager.create(SalePayment, {
      company_id: String(companyId),
      sale_invoice_id: sale.id,
      payment_method: SalePaymentMethod.TRANSFER,
      amount: amountPaid,
      change_amount: change,
      bank_id: bank.id,
      bank_name: bank.name,
      account_type: 'bank' satisfies SalePaymentAccountType,
      account_id: bank.id,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
      uuid: idempotencyKey,
    });
    const savedPayment = await manager.save(SalePayment, payment);
    const paymentId = Number(savedPayment.id);

    // UPDATE bank.balance += amount_due.
    const newBalance = preciseNumber(toBig(bank.balance).plus(amountDueBig), 2);
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
      amount: preciseNumber(amountDueBig, 2),
      movement_type: MovementType.INCOME,
      concept: MovementConcept.SALE,
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

  private async deductInventory(
    manager: EntityManager,
    companyId: number,
    lines: Array<{ item_id: number; quantity: number }>,
  ): Promise<void> {
    // El helper actual es stub (Fase 3 no añadió Product.stock). Mantiene la
    // firma para que cuando aterrice `Product.stock` el caller no cambie.
    await adjustInventory(manager, companyId, lines, 'DEDUCT');
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
    const payment = await this.dataSource.getRepository(SalePayment).findOne({
      where: { company_id: String(companyId), uuid: idempotencyKey },
    });
    if (!payment) {
      return null;
    }
    // Recuperar credit asociado al sale_invoice (puede no existir).
    const credit = await this.dataSource.getRepository(SaleCredit).findOne({
      where: {
        company_id: String(companyId),
        sale_invoice_id: payment.sale_invoice_id,
      },
    });
    this.logger.log({
      event: 'payment.idempotent_replay',
      companyId,
      idempotencyKey,
      paymentId: Number(payment.id),
    });
    return {
      success: true,
      message: 'Pago procesado exitosamente (reintento idempotente)',
      payment_id: Number(payment.id),
      credit_id: credit ? Number(credit.id) : null,
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
