import { HttpException, Injectable, Logger } from '@nestjs/common';
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
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { SaleCredit, SaleCreditStatus } from '@/modules/sales/entities/sale-credit.entity';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { SalePayment, SalePaymentMethod } from '@/modules/sales/entities/sale-payment.entity';

import type { ProcessCreditPaymentDto } from '../dto/process-credit-payment.dto';

/**
 * Snapshot del actor (User / Employee) que registra el abono.
 */
export interface CreditPaymentActor {
  id: number;
  fullName: string;
}

/**
 * Códigos de error semánticos que la action emite hacia el controller.
 * El controller los traduce a 422 con el `{ code }` en el payload.
 */
export type CreditPaymentFailureCode =
  | 'CREDIT_NOT_FOUND'
  | 'CREDIT_ALREADY_PAID'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_EXCEEDS_BALANCE'
  | 'BANK_REQUIRED'
  | 'BANK_NOT_FOUND'
  | 'INVALID_PAYMENT_METHOD'
  | 'BUSINESS_RULE_VIOLATED';

/**
 * Resultado tipo discriminated union — la action NO lanza para los casos de
 * negocio (CREDIT_NOT_FOUND, AMOUNT_EXCEEDS_BALANCE, etc.); los devuelve.
 * Solo errores de infraestructura imprevistos se propagan como excepción.
 *
 * Espejo de `ProcessCreditPaymentResult` de PlacePos con el añadido `code`
 * para que el controller decida 422 sin parsear mensajes.
 */
/**
 * Status del crédito devuelto al cliente PlacePos. El renderer
 * (`TicketViewer/components/InstallmentModal/index.tsx`, `preload/index.d.ts`)
 * compara contra `'PARTIAL' | 'PAID' | 'PENDING'`. El enum interno DB usa
 * `PARTIALLY_PAID` — al borde de salida lo mapeamos a `PARTIAL` para paridad
 * de contrato.
 */
export type CreditStatusClientLabel = 'PENDING' | 'PARTIAL' | 'PAID';

export type ProcessCreditPaymentResult =
  | {
      success: true;
      message: string;
      payment_id: number;
      credit_status: CreditStatusClientLabel;
      credit_balance: number;
    }
  | {
      success: false;
      message: string;
      code: CreditPaymentFailureCode;
      payment_id: null;
      credit_status: null;
      credit_balance: null;
    };

/**
 * Tolerancia para el chequeo `amount > balance` (en pesos). Compara Big.js
 * con margen de medio centavo para absorber redondeos del cliente.
 */
const AMOUNT_BALANCE_TOLERANCE = '0.01';

/**
 * Action `POST /credits` — espejo PlacePos `processCreditPayment`.
 *
 * --------------------------------------------------------------------------
 * Flujo atómico (UNA transacción)
 * --------------------------------------------------------------------------
 *
 *   1. SELECT SaleCredit por (`sale_invoice_id`, `company_id`) con
 *      `pessimistic_write`. Si no existe → 422 `CREDIT_NOT_FOUND`.
 *
 *   2. Validar `status != PAID`. Si ya pagó → 422 `CREDIT_ALREADY_PAID`.
 *
 *   3. Validar `amount > 0` y `amount <= balance + tolerancia` (Big.js).
 *
 *   4. INSERT SalePayment ligado a la venta original (`sale_invoice_id =
 *      credit.sale_invoice_id`). Snapshot de `bank_id/bank_name` para
 *      TRANSFER; `account_type/account_id` lo asigna la action según el
 *      método (CASH → caja del actor; TRANSFER → bank.id).
 *
 *   5. Side effects según método:
 *      - **CASH**: lock + UPDATE `cash_register.balance += amount` +
 *        INSERT CashRegisterLog tipo `CREDIT_PAYMENT`, direction=IN,
 *        `affects_balance=true`, `is_credit_related=true`.
 *      - **TRANSFER**: lock + UPDATE `bank.balance += amount` +
 *        FinancialMovement(INCOME, concept=`SALE_PAYMENT` — paridad
 *        PlacePos, NO `CREDIT_PAYMENT`).
 *
 *   6. UPDATE SaleCredit: `paid_amount += amount`, `balance -= amount`,
 *      `status = PAID` si balance≈0 sino `PARTIALLY_PAID`.
 *
 *   7. **NO** se toca `Customer.balance` — paridad PlacePos
 *      (`processCreditPayment` no decrementa balance de cliente; solo
 *      `createSaleCredit` lo hace al CREAR el crédito).
 *
 * --------------------------------------------------------------------------
 * Diferencias con paridad y por qué
 * --------------------------------------------------------------------------
 *
 *   - PlacePos usa `CreditStatus.PARTIAL`; este API usa `PARTIALLY_PAID`
 *     (valor del enum Postgres `credit_status` creado en la migración).
 *     El service convierte para que la response salga consistente.
 *
 *   - PlacePos NO incluye `company_id` ni `account_type/account_id` en
 *     `SalePayment` (no son columnas allí). Aquí los rellenamos como parte
 *     del modelo multi-tenant + integridad de auditoría.
 *
 *   - El concept del FinancialMovement TRANSFER es `SALE_PAYMENT` (paridad
 *     PlacePos: `MovementConcept.SALE_PAYMENT`). No usamos `CREDIT_PAYMENT`
 *     aunque exista en el enum — preservamos el valor que el front espera.
 */
@Injectable()
export class ProcessCreditPaymentAction {
  private readonly logger = new Logger(ProcessCreditPaymentAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    dto: ProcessCreditPaymentDto,
    companyId: number,
    actor: CreditPaymentActor,
  ): Promise<ProcessCreditPaymentResult> {
    // Validación de payment_method: solo CASH | TRANSFER (el DTO la asegura
    // con `@IsEnum(SalePaymentMethod)`, pero defensive-check explícito por
    // si el enum se extiende a futuro).
    if (
      dto.payment_method !== SalePaymentMethod.CASH &&
      dto.payment_method !== SalePaymentMethod.TRANSFER
    ) {
      return this.failure('Método de pago no soportado para abono.', 'INVALID_PAYMENT_METHOD');
    }

    // Validación TRANSFER requiere bank_id (DTO ya lo valida vía @ValidateIf,
    // mantenemos guard).
    if (dto.payment_method === SalePaymentMethod.TRANSFER && !dto.bank_id) {
      return this.failure('Se requiere bank_id para abono por transferencia.', 'BANK_REQUIRED');
    }

    try {
      // SERIALIZABLE: paridad con ProcessPaymentAction / VoidSaleAction.
      // CLAUDE.md §9.4: generación/aplicación a SaleCredit es flujo financiero
      // crítico (lock pessimistic + balance updates concurrentes).
      return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
        // 1. Lookup SaleCredit con lock pessimistic_write — bloquea
        //    actualizaciones concurrentes (otro abono, anulación de NC).
        const credit = await manager.findOne(SaleCredit, {
          where: {
            sale_invoice_id: String(dto.invoice_id),
            company_id: String(companyId),
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!credit) {
          return this.failure(
            'No se encontró un crédito pendiente para esta factura.',
            'CREDIT_NOT_FOUND',
          );
        }

        // 2. Status: si ya pagó, 422.
        if (credit.status === SaleCreditStatus.PAID) {
          return this.failure('El crédito ya fue pagado completamente.', 'CREDIT_ALREADY_PAID');
        }

        // 3. Validar amount con Big.js.
        const amountBig = toBig(dto.amount);
        if (amountBig.lte(0)) {
          return this.failure('El monto del abono debe ser mayor a 0.', 'INVALID_AMOUNT');
        }
        const balanceBig = toBig(credit.balance);
        if (amountBig.gt(balanceBig.plus(AMOUNT_BALANCE_TOLERANCE))) {
          return this.failure(
            `El monto del abono ($${preciseNumber(amountBig, 2)}) excede el saldo pendiente ($${preciseNumber(balanceBig, 2)}).`,
            'AMOUNT_EXCEEDS_BALANCE',
          );
        }

        const amount = preciseNumber(amountBig, 2);

        // Resolver cuentas / preparar snapshot según método.
        let accountType: 'cash_register' | 'bank';
        let accountId: number;
        let bankIdSnapshot: number | null = null;
        let bankNameSnapshot: string | null = null;
        let cashRegister: CashRegister | null = null;
        let bank: Bank | null = null;

        if (dto.payment_method === SalePaymentMethod.CASH) {
          // Resolver + lockear caja del actor (lock pessimistic_write dentro
          // del helper).
          cashRegister = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
          accountType = 'cash_register';
          accountId = Number(cashRegister.id);
        } else {
          // TRANSFER: bank_id requerido (ya validado arriba). Lock pessimistic
          // sobre el row del banco para acreditar atómicamente.
          bank = await manager.findOne(Bank, {
            where: {
              id: String(dto.bank_id),
              company_id: String(companyId),
              is_archived: false,
            },
            lock: { mode: 'pessimistic_write' },
          });
          if (!bank) {
            return this.failure('Cuenta bancaria no encontrada.', 'BANK_NOT_FOUND');
          }
          accountType = 'bank';
          accountId = Number(bank.id);
          bankIdSnapshot = Number(bank.id);
          bankNameSnapshot = dto.bank_name ?? bank.name;
        }

        // 4. INSERT SalePayment. uuid auto-generado (no es idempotente vía
        //    cliente — PlacePos tampoco lo expone para abonos). El UNIQUE
        //    parcial `(company_id, uuid)` lo blinda contra colisiones
        //    fortuitas con otros pagos.
        const paymentEntity = manager.create(SalePayment, {
          company_id: String(companyId),
          sale_invoice_id: credit.sale_invoice_id,
          payment_method: dto.payment_method,
          amount,
          change_amount: 0,
          bank_id: bankIdSnapshot === null ? null : String(bankIdSnapshot),
          bank_name: bankNameSnapshot,
          account_type: accountType,
          account_id: String(accountId),
          created_by: actor.fullName,
          created_by_id: String(actor.id),
          uuid: randomUUID(),
        });
        const savedPayment = await manager.save(SalePayment, paymentEntity);
        const paymentId = Number(savedPayment.id);

        // 5. Side effects.
        const saleInvoiceId = Number(credit.sale_invoice_id);
        if (dto.payment_method === SalePaymentMethod.CASH) {
          // Modelo PERMANENTE: balance vive en la columna, log es auditoría.
          // PlacePos registra `affects_balance=true` para este flujo
          // (registerCashPayment → registerCashMovement con affectsBalance=true).
          await this.creditCashRegister(
            manager,
            cashRegister as CashRegister,
            amountBig,
            companyId,
            saleInvoiceId,
            paymentId,
            actor,
          );
        } else {
          await this.creditBank(manager, bank as Bank, amountBig, companyId);
          // FinancialMovement para auditoría — concept SALE_PAYMENT (paridad
          // PlacePos `MovementConcept.SALE_PAYMENT`).
          const sale = await manager.findOne(SaleInvoice, {
            where: { id: credit.sale_invoice_id, company_id: String(companyId) },
            select: { id: true, sale_number: true, ticket_number: true },
          });
          const saleLabel = sale?.sale_number ?? sale?.ticket_number ?? `#${saleInvoiceId}`;
          await this.financialMovementsService.record(manager, {
            companyId,
            amount,
            movement_type: MovementType.INCOME,
            // Paridad estricta con PlacePos `creditPaymentOperations.ts`:
            // los abonos a crédito se categorizan como `SALE_PAYMENT` para
            // que los reportes financieros de cloud y server-local
            // concilien sobre la misma categoría.
            concept: MovementConcept.SALE_PAYMENT,
            description: `Abono a crédito por transferencia - Venta ${saleLabel}`,
            source_type: 'external',
            source_id: Number(credit.customer_id),
            destination_type: 'bank',
            destination_id: Number((bank as Bank).id),
            reference_code: savedPayment.uuid ?? null,
            created_by: actor.fullName,
            created_by_id: actor.id,
          });
        }

        // 6. UPDATE SaleCredit con nuevos paid/balance/status.
        const newPaidBig = toBig(credit.paid_amount).plus(amountBig);
        const newBalanceBig = toBig(credit.total_amount).minus(newPaidBig);
        const newPaid = preciseNumber(newPaidBig, 2);
        // Floor a 0 para satisfacer CHECK `balance >= 0` ante redondeo.
        const newBalance = Math.max(0, preciseNumber(newBalanceBig, 2));
        const newStatus: SaleCreditStatus =
          newBalance <= 0 ? SaleCreditStatus.PAID : SaleCreditStatus.PARTIALLY_PAID;

        await manager.update(
          SaleCredit,
          { id: credit.id, company_id: String(companyId) },
          {
            paid_amount: newPaid,
            balance: newBalance,
            status: newStatus,
          },
        );

        const statusLabel =
          newStatus === SaleCreditStatus.PAID ? 'Crédito pagado completamente' : 'Abono registrado';

        // Mapeo enum interno → label PlacePos. Storage DB no cambia (sigue
        // `PARTIALLY_PAID`); solo se traduce al borde de salida del endpoint.
        const credit_status_response: CreditStatusClientLabel =
          newStatus === SaleCreditStatus.PAID
            ? 'PAID'
            : newStatus === SaleCreditStatus.PARTIALLY_PAID
              ? 'PARTIAL'
              : 'PENDING';

        return {
          success: true,
          message: `${statusLabel}. Saldo pendiente: $${newBalance}`,
          payment_id: paymentId,
          credit_status: credit_status_response,
          credit_balance: newBalance,
        } satisfies ProcessCreditPaymentResult;
      });
    } catch (error) {
      this.logger.error(
        `Error al procesar abono a crédito invoice_id=${dto.invoice_id} company=${companyId}`,
        error instanceof Error ? error.stack : String(error),
      );
      // Solo capturamos HttpException de dominio (422 BadRequest internas).
      // Los demás errores (deadlocks PG, serialization_failure, infra) pasan
      // al AllExceptionsFilter → 500 con stack en log. Evita enmascarar fallas
      // transitorias como errores de negocio.
      if (error instanceof HttpException) {
        const response = error.getResponse();
        const message =
          typeof response === 'string'
            ? response
            : ((response as { message?: string }).message ?? error.message);
        return this.failure(message, 'BUSINESS_RULE_VIOLATED');
      }
      throw error;
    }
  }

  /**
   * Acredita la caja del actor + inserta log `CREDIT_PAYMENT` (espejo
   * PlacePos `registerCashPayment` con `isCreditRelated=true`).
   */
  private async creditCashRegister(
    manager: EntityManager,
    cashRegister: CashRegister,
    amountBig: Big,
    companyId: number,
    saleInvoiceId: number,
    paymentId: number,
    actor: CreditPaymentActor,
  ): Promise<void> {
    const amount = preciseNumber(amountBig, 2);
    const newBalance = preciseNumber(toBig(cashRegister.balance).plus(amountBig), 2);
    await manager.update(
      CashRegister,
      { id: cashRegister.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    const log = manager.create(CashRegisterLog, {
      company_id: String(companyId),
      cash_register_id: cashRegister.id,
      type: CashRegisterLogType.CREDIT_PAYMENT,
      direction: 'IN',
      amount,
      affects_balance: true,
      is_credit_related: true,
      description: `Abono en efectivo a crédito - Venta #${saleInvoiceId}`,
      invoice_id: String(saleInvoiceId),
      payment_id: String(paymentId),
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    });
    await manager.save(CashRegisterLog, log);
  }

  /**
   * Acredita el banco con UPDATE atómico (lock ya tomado al lookup).
   */
  private async creditBank(
    manager: EntityManager,
    bank: Bank,
    amountBig: Big,
    companyId: number,
  ): Promise<void> {
    const newBalance = preciseNumber(toBig(bank.balance).plus(amountBig), 2);
    await manager.update(
      Bank,
      { id: bank.id, company_id: String(companyId) },
      { balance: newBalance },
    );
  }

  private failure(message: string, code: CreditPaymentFailureCode): ProcessCreditPaymentResult {
    return {
      success: false,
      message,
      code,
      payment_id: null,
      credit_status: null,
      credit_balance: null,
    };
  }
}
