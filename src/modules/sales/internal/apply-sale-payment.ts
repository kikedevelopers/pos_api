import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type Big from 'big.js';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import {
  CashRegister,
  CashRegisterStatus,
} from '@/modules/cash-register/entities/cash-register.entity';
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
 * Input para aplicar un cobro a una venta dentro de una transacción.
 */
export interface ApplySalePaymentInput {
  saleId: number;
  companyId: number;
  ticketReference: string;
  account_type: SalePaymentAccountType;
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
 * Aplica un cobro a una venta DENTRO de la transacción del caller:
 *
 *   1. Fast-path idempotencia: si `uuid` ya existe en `sale_payments` para
 *      la company, devuelve el row sin reprocesar.
 *   2. Resuelve la cuenta receptora dentro de la company (Bank / Wallet /
 *      CashRegister abierto). Para Bank / Wallet aplica `SELECT FOR UPDATE`
 *      para evitar race conditions y `UPDATE balance += amount`.
 *      Para cash_register inserta `CashRegisterLog(IN, CASH_IN)`.
 *   3. INSERT `SalePayment` con snapshot de bank_id/bank_name si aplica.
 *      Si llega un 23505 sobre el índice del uuid, releemos el ganador
 *      y devolvemos como idempotente.
 *   4. Registra `FinancialMovement(INCOME, SALE)` con source='external'
 *      (cliente) y destination=cuenta receptora.
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

  // 2. Resolver y acreditar la cuenta receptora.
  const credited = await creditDestination(
    manager,
    input.account_type,
    input.account_id,
    input.companyId,
    amountBig,
    input.ticketReference,
    input.actor,
  );

  // 3. INSERT SalePayment.
  const paymentEntity = manager.create(SalePayment, {
    company_id: String(input.companyId),
    sale_invoice_id: String(input.saleId),
    payment_method: credited.paymentMethod,
    amount,
    change_amount: change,
    bank_id: credited.bankId === null ? null : String(credited.bankId),
    bank_name: credited.bankName,
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
        return { payment: winner, idempotent: true };
      }
    }
    throw error;
  }

  // 4. FinancialMovement (INCOME, SALE).
  await financialMovementsService.record(manager, {
    companyId: input.companyId,
    amount,
    movement_type: MovementType.INCOME,
    concept: MovementConcept.SALE,
    description: `Cobro de venta ${input.ticketReference}`,
    source_type: 'external',
    source_id: null,
    destination_type: input.account_type,
    destination_id: input.account_id,
    reference_code: `SALE-${input.ticketReference}`,
    created_by: input.actor.fullName,
    created_by_id: input.actor.id,
  });

  return { payment: savedPayment, idempotent: false };
}

/**
 * Resuelve la cuenta receptora, valida ownership y acredita el monto.
 *
 * Devuelve metadatos necesarios para serializar el SalePayment:
 *   - `paymentMethod`: TRANSFER si bank, CASH para wallet/cash_register.
 *   - `bankId`/`bankName`: snapshot para frontend.
 */
async function creditDestination(
  manager: EntityManager,
  accountType: SalePaymentAccountType,
  accountId: number,
  companyId: number,
  amountBig: Big,
  ticketReference: string,
  actor: SalePaymentActor,
): Promise<{
  bankId: number | null;
  bankName: string | null;
  paymentMethod: SalePaymentMethod;
}> {
  const amount = preciseNumber(amountBig, 2);

  if (accountType === 'bank') {
    const bank = await manager.findOne(Bank, {
      where: {
        id: String(accountId),
        company_id: String(companyId),
        is_archived: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bank) {
      throw new NotFoundException('Cuenta bancaria no encontrada');
    }
    const newBalance = preciseNumber(toBig(bank.balance).plus(amountBig), 2);
    await manager.update(
      Bank,
      { id: bank.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    return {
      bankId: Number(bank.id),
      bankName: bank.name,
      paymentMethod: SalePaymentMethod.TRANSFER,
    };
  }

  if (accountType === 'wallet') {
    const wallet = await manager.findOne(Wallet, {
      where: {
        id: String(accountId),
        company_id: String(companyId),
        is_archived: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!wallet) {
      throw new NotFoundException('Billetera no encontrada');
    }
    const newBalance = preciseNumber(toBig(wallet.balance).plus(amountBig), 2);
    await manager.update(
      Wallet,
      { id: wallet.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    return {
      bankId: null,
      bankName: null,
      paymentMethod: SalePaymentMethod.CASH,
    };
  }

  // accountType === 'cash_register'
  const open = await manager.findOne(CashRegister, {
    where: { company_id: String(companyId), status: CashRegisterStatus.OPEN },
    lock: { mode: 'pessimistic_write' },
  });
  if (!open) {
    throw new NotFoundException('No hay caja abierta');
  }
  const log = manager.create(CashRegisterLog, {
    company_id: String(companyId),
    cash_register_id: open.id,
    type: CashRegisterLogType.CASH_IN,
    direction: 'IN',
    amount,
    affects_balance: true,
    description: `Cobro de venta ${ticketReference}`,
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  });
  await manager.save(CashRegisterLog, log);
  return {
    bankId: null,
    bankName: null,
    paymentMethod: SalePaymentMethod.CASH,
  };
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
