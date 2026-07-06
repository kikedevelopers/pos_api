import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type Big from 'big.js';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';

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
import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import {
  SalePayment,
  SalePaymentMethod,
  type SalePaymentAccountType,
} from '../entities/sale-payment.entity';
import { SaleInvoice } from '../entities/sale-invoice.entity';
import { isSalePaymentUuidConflict } from './constraint-errors';

/**
 * Datos del actor que realiza el cobro (snapshot en payment y financial
 * movement).
 */
export interface SalePaymentActor {
  id: number;
  fullName: string;
}

/**
 * Cuentas de dinero REAL que este helper de venta directa sabe acreditar
 * (bank / wallet / cash_register). Excluye `'customer_advance'`: el pago con
 * anticipo NO mueve una cuenta de dinero (el efectivo/banco ya ingresó al
 * crear el anticipo) y se procesa exclusivamente en
 * `ProcessPaymentAction.applyAdvance`, nunca por este flujo. La exclusión
 * garantiza a nivel de tipos que `account_type` sea siempre un
 * `AccountReference` válido para el `FinancialMovement`.
 */
type MoneyAccountType = Exclude<SalePaymentAccountType, 'customer_advance'>;

/**
 * Input para aplicar un cobro a una venta dentro de una transacción.
 */
export interface ApplySalePaymentInput {
  saleId: number;
  companyId: number;
  ticketReference: string;
  /**
   * Customer asociado a la venta (si lo hay). Se persiste como
   * `source_id` en el FinancialMovement(INCOME, SALE) cuando NO es null.
   * Si es null (venta mostrador sin cliente), el movement se persiste con
   * `source_type=null, source_id=null` para satisfacer el CHECK
   * `chk_financial_movements_source_consistency` (CRIT-1 auditoría Fase 7).
   */
  customerId?: number | null;
  account_type: MoneyAccountType;
  account_id: number;
  amount: number;
  change_amount?: number;
  uuid?: string | null;
  actor: SalePaymentActor;
}

/**
 * Resultado de aplicar un pago. `idempotent = true` si el uuid ya estaba
 * procesado y se devolvió el row existente.
 */
export interface ApplySalePaymentResult {
  payment: SalePayment;
  idempotent: boolean;
}

/**
 * Snapshot de la cuenta receptora — leído ANTES del INSERT del payment para
 * armar el row (bank_id, bank_name, payment_method). NO lockea ni acredita:
 * el credit real ocurre después del INSERT.
 */
interface AccountResolution {
  bankId: number | null;
  bankName: string | null;
  paymentMethod: SalePaymentMethod;
  /** Solo para cash_register: el row del turno abierto (para reusarlo en el credit step). */
  cashRegister: CashRegister | null;
}

/**
 * Aplica un cobro a una venta DENTRO de la transacción del caller.
 *
 * --------------------------------------------------------------------------
 * Orden de operaciones (CRIT-1 + HIGH-1 auditoría)
 * --------------------------------------------------------------------------
 *
 *   1. Fast-path idempotencia (lookup por uuid). Si existe y `sale_invoice_id`
 *      coincide → devolver `idempotent=true` SIN acreditar nada.
 *      Si existe pero pertenece a OTRA venta → 422 (uuid colisionado).
 *
 *   2. **Resolver la cuenta SIN lock ni UPDATE** — solo metadata (name,
 *      payment_method, snapshot para columnas). Esto valida existencia y
 *      ownership multi-tenant sin tocar saldo.
 *
 *   3. **INSERT optimista del SalePayment**. Este es el "barrera anti-race":
 *      el UNIQUE parcial `(company_id, uuid) WHERE uuid IS NOT NULL` rechaza
 *      cualquier duplicate con `23505`. Si dos requests concurrentes con el
 *      mismo `uuid` llegan al INSERT, solo UNO gana — el otro entra al catch
 *      y se trata como idempotente. **Crucialmente, hasta este punto nadie
 *      ha modificado el balance de la cuenta receptora**, así que el loser
 *      no produce side-effects: su transacción hará rollback al retornar
 *      con `idempotent=true`, pero como no hizo UPDATE ni INSERT de log, el
 *      rollback es no-op contable.
 *
 *      En el catch del 23505 se valida `winner.sale_invoice_id === saleId`
 *      (HIGH-1): si el uuid se reutilizó para otra venta, 422.
 *
 *   4. **Después del INSERT exitoso**: acreditar la cuenta receptora con
 *      lock pessimistic_write + UPDATE balance / INSERT CashRegisterLog.
 *      Esto SIEMPRE se hace solo para el ganador.
 *
 *   5. `FinancialMovement(INCOME, SALE)` para auditoría.
 *
 * --------------------------------------------------------------------------
 * Por qué INSERT primero, credit después
 * --------------------------------------------------------------------------
 *
 * El orden inverso (credit primero, INSERT después) era el bug original
 * (CRIT-1): dos requests concurrentes acreditaban ambas la cuenta, después
 * una ganaba el INSERT y la otra retornaba "idempotent=true" — el caller
 * cree que todo está bien, pero el balance de la cuenta receptora subió 2x.
 * Mover el INSERT al inicio convierte el UNIQUE constraint en un latch
 * lock-free para la idempotencia.
 *
 * El caller es responsable de:
 *   - Actualizar `SaleCredit` (balance/paid/status) si la venta es a crédito.
 *   - Actualizar `Customer.balance` (signed) si aplica.
 */
export async function applySalePayment(
  manager: EntityManager,
  financialMovementsService: FinancialMovementsService,
  input: ApplySalePaymentInput,
): Promise<ApplySalePaymentResult> {
  const idempotencyKey = input.uuid ?? randomUUID();
  const amountBig = toBig(input.amount);
  if (amountBig.lte(0)) {
    throw new UnprocessableEntityException('El monto del cobro debe ser mayor a cero');
  }
  const amount = preciseNumber(amountBig, 2);
  const change = preciseNumber(toBig(input.change_amount ?? 0), 2);

  // 1. Fast-path idempotencia.
  const existing = await manager.findOne(SalePayment, {
    where: { company_id: String(input.companyId), uuid: idempotencyKey },
  });
  if (existing) {
    if (Number(existing.sale_invoice_id) !== input.saleId) {
      throw new UnprocessableEntityException('El uuid ya fue utilizado para otra venta');
    }
    return { payment: existing, idempotent: true };
  }

  // 2. Resolver cuenta SIN lock ni UPDATE. Solo lookup para obtener metadata
  //    y validar ownership multi-tenant. El balance NO se toca aquí.
  //    NOTA: para cash_register el helper SÍ lockea la caja del actor (paridad
  //    PlacePos + defensa contra carrera con `creditDestination`).
  const resolution = await resolveAccount(
    manager,
    input.account_type,
    input.account_id,
    input.companyId,
    input.actor,
  );

  // 3. INSERT optimista — el UNIQUE constraint actúa como latch atómico.
  const paymentEntity = manager.create(SalePayment, {
    company_id: String(input.companyId),
    sale_invoice_id: String(input.saleId),
    payment_method: resolution.paymentMethod,
    amount,
    change_amount: change,
    bank_id: resolution.bankId === null ? null : String(resolution.bankId),
    bank_name: resolution.bankName,
    account_type: input.account_type,
    account_id: String(input.account_id),
    created_by: input.actor.fullName,
    created_by_id: String(input.actor.id),
    uuid: idempotencyKey,
  });

  let savedPayment: SalePayment;
  try {
    savedPayment = await manager.save(SalePayment, paymentEntity);
  } catch (error) {
    if (isSalePaymentUuidConflict(error)) {
      const winner = await manager.findOne(SalePayment, {
        where: { company_id: String(input.companyId), uuid: idempotencyKey },
      });
      if (winner) {
        // HIGH-1 auditoría: validar que el ganador pertenece a la MISMA
        // venta. Sin esto, dos pagos concurrentes con el mismo uuid pero
        // distinto saleId producirían que el loser retorne "idempotent" con
        // un payment de otra venta — response inconsistente.
        if (Number(winner.sale_invoice_id) !== input.saleId) {
          throw new UnprocessableEntityException('El uuid ya fue utilizado para otra venta');
        }
        return { payment: winner, idempotent: true };
      }
    }
    throw error;
  }

  // 4. Solo el ganador llega aquí. Acreditar cuenta con lock + UPDATE.
  await creditDestination(
    manager,
    input.account_type,
    input.account_id,
    input.companyId,
    amountBig,
    input.ticketReference,
    input.actor,
    resolution.cashRegister,
  );

  // 5. FinancialMovement (INCOME, SALE).
  // CRIT-1 auditoría Fase 7: el CHECK `chk_financial_movements_source_consistency`
  // exige source_type y source_id ambos NULL o ambos NOT NULL. Antes pasábamos
  // `source_type='external', source_id=null` que rompía el INSERT en DB real.
  // Si la venta tiene customer, usamos el customer_id como source_id (semántica
  // clara: el dinero viene del cliente). Si es venta mostrador sin cliente,
  // omitimos el lado source — el movement queda solo con destination (el
  // CHECK `chk_financial_movements_has_endpoint` se satisface).
  const sourceFields =
    input.customerId !== null && input.customerId !== undefined
      ? { source_type: 'external' as const, source_id: input.customerId }
      : { source_type: null, source_id: null };
  await financialMovementsService.record(manager, {
    companyId: input.companyId,
    amount,
    movement_type: MovementType.INCOME,
    concept: MovementConcept.SALE,
    description: `Cobro de venta ${input.ticketReference}`,
    ...sourceFields,
    destination_type: input.account_type,
    destination_id: input.account_id,
    reference_code: `SALE-${input.ticketReference}`,
    created_by: input.actor.fullName,
    created_by_id: input.actor.id,
  });

  return { payment: savedPayment, idempotent: false };
}

/**
 * Lookup read-only de la cuenta receptora. Valida ownership multi-tenant
 * (incluyendo `is_archived = false` para bank/wallet) pero NO bloquea ni
 * acredita. Devuelve metadata para armar el row de SalePayment.
 *
 * Para `cash_register`, además del lookup metadata se retorna el row para
 * reusarlo en `creditDestination`. La resolución usa
 * `getOrCreateCashRegisterForUser` (modelo PERMANENTE) y SÍ lockea la caja
 * — el row queda bloqueado para el credit step subsiguiente.
 */
async function resolveAccount(
  manager: EntityManager,
  accountType: MoneyAccountType,
  accountId: number,
  companyId: number,
  actor: SalePaymentActor,
): Promise<AccountResolution> {
  if (accountType === 'bank') {
    const bank = await manager.findOne(Bank, {
      where: {
        id: String(accountId),
        company_id: String(companyId),
        is_archived: false,
      },
      select: { id: true, name: true },
    });
    if (!bank) {
      throw new NotFoundException('Cuenta bancaria no encontrada');
    }
    return {
      bankId: Number(bank.id),
      bankName: bank.name,
      paymentMethod: SalePaymentMethod.TRANSFER,
      cashRegister: null,
    };
  }

  if (accountType === 'wallet') {
    const wallet = await manager.findOne(Wallet, {
      where: {
        id: String(accountId),
        company_id: String(companyId),
        is_archived: false,
      },
      select: { id: true, name: true },
    });
    if (!wallet) {
      throw new NotFoundException('Billetera no encontrada');
    }
    return {
      bankId: null,
      bankName: null,
      paymentMethod: SalePaymentMethod.CASH,
      cashRegister: null,
    };
  }

  // accountType === 'cash_register'
  // Modelo PERMANENTE: la caja del actor (por user_id) se resuelve con lock
  // pessimistic_write — coherente con purchases y carrier-payments.
  const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
  return {
    bankId: null,
    bankName: null,
    paymentMethod: SalePaymentMethod.CASH,
    cashRegister: register,
  };
}

/**
 * Acredita el monto en la cuenta receptora. Llamado SOLO después del INSERT
 * exitoso del SalePayment — el caller idempotente nunca llega aquí.
 *
 * Para Bank/Wallet hace lock pessimistic_write + UPDATE atómico del balance.
 * Para cash_register reusa el row ya lockeado en `resolveAccount` e inserta
 * el log IN.
 */
async function creditDestination(
  manager: EntityManager,
  accountType: MoneyAccountType,
  accountId: number,
  companyId: number,
  amountBig: Big,
  ticketReference: string,
  actor: SalePaymentActor,
  cashRegister: CashRegister | null,
): Promise<void> {
  const amount = preciseNumber(amountBig, 2);

  if (accountType === 'bank') {
    const bank = await manager.findOne(Bank, {
      where: { id: String(accountId), company_id: String(companyId), is_archived: false },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bank) {
      // Caso extremo: la cuenta fue archivada entre el resolve (read-only) y
      // el credit. Lanzamos 422 — el rollback recupera el INSERT del payment.
      throw new UnprocessableEntityException('La cuenta bancaria dejó de estar disponible');
    }
    const newBalance = preciseNumber(toBig(bank.balance).plus(amountBig), 2);
    await manager.update(
      Bank,
      { id: bank.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    return;
  }

  if (accountType === 'wallet') {
    const wallet = await manager.findOne(Wallet, {
      where: { id: String(accountId), company_id: String(companyId), is_archived: false },
      lock: { mode: 'pessimistic_write' },
    });
    if (!wallet) {
      throw new UnprocessableEntityException('La billetera dejó de estar disponible');
    }
    const newBalance = preciseNumber(toBig(wallet.balance).plus(amountBig), 2);
    await manager.update(
      Wallet,
      { id: wallet.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    return;
  }

  // accountType === 'cash_register' — usa el row ya lockeado en resolveAccount.
  if (!cashRegister) {
    throw new NotFoundException('No se pudo resolver la caja del actor');
  }
  // Modelo PERMANENTE: el balance vive en la columna y se mutea con UPDATE.
  // El log SOLO documenta — `affects_balance` queda como bandera informativa.
  const newBalance = preciseNumber(toBig(cashRegister.balance).plus(amountBig), 2);
  await manager.update(
    CashRegister,
    { id: cashRegister.id, company_id: String(companyId) },
    { balance: newBalance },
  );
  const log = manager.create(CashRegisterLog, {
    company_id: String(companyId),
    cash_register_id: cashRegister.id,
    type: CashRegisterLogType.CASH_RECEIVED,
    direction: 'IN',
    amount,
    affects_balance: true,
    description: `Cobro de venta ${ticketReference}`,
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  });
  await manager.save(CashRegisterLog, log);
}

/**
 * Carga la venta con lock pessimistic_write — usado al aplicar pagos para
 * evitar race con anulaciones / conversiones. Re-exporta el helper de
 * `sale-lookups` con `lock: true`.
 */
export async function loadSaleForUpdate(
  manager: EntityManager,
  saleId: number,
  companyId: number,
): Promise<SaleInvoice> {
  const sale = await manager.findOne(SaleInvoice, {
    where: { id: String(saleId), company_id: String(companyId), is_deleted: false },
    lock: { mode: 'pessimistic_write' },
  });
  if (!sale) {
    throw new NotFoundException('Venta no encontrada');
  }
  return sale;
}
