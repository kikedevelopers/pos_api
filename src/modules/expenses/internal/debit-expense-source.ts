import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type Big from 'big.js';
import type { EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { requireOpenCashRegisterForUpdate } from '@/modules/cash-register/internal/cash-register-lookups';
import { computeCashRegisterBalance } from '@/modules/cash-register/internal/compute-balance';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { ExpenseSourceType } from '../entities/expense.entity';

/**
 * Actor (snapshot del usuario que origina el gasto). Mismo shape que en
 * `purchase-payment.action`/`sale-payment.action` para mantener consistencia.
 */
export interface ExpenseActor {
  id: number;
  fullName: string;
}

/**
 * Resultado de debitar la fuente: nombre legible (snapshot) y, cuando la
 * fuente es cash_register, el id del turno abierto (que PlacePos ignora del
 * payload del cliente y resuelve server-side).
 */
export interface DebitExpenseSourceResult {
  /** Snapshot del nombre — guardado en `Expense.source_name`. */
  sourceName: string;
  /** ID resuelto: el del turno abierto si source_type=cash_register; sino igual al payload. */
  resolvedSourceId: number;
}

/**
 * Debita el monto de la cuenta origen con lock pessimistic_write. Aborta con:
 *   - `NotFoundException` si la cuenta no existe en la company o está
 *     archivada.
 *   - `UnprocessableEntityException` si el balance es insuficiente.
 *
 * Mismo patrón que `register-purchase-payment.action.debitSource`. Encapsulado
 * en helper porque se reusa entre `CreateExpenseAction` (debita) y la
 * acreditación del soft-delete (que añade en vez de restar — `addToSource`).
 *
 * **Lock pessimistic_write**: garantiza que dos gastos concurrentes contra la
 * misma cuenta no validen ambos balance>=amount antes del UPDATE — el segundo
 * espera al commit del primero y re-lee el balance actualizado.
 */
export async function debitExpenseSource(
  manager: EntityManager,
  sourceType: ExpenseSourceType,
  sourceId: number,
  companyId: number,
  amountBig: Big,
  actor: ExpenseActor,
): Promise<DebitExpenseSourceResult> {
  const amount = preciseNumber(amountBig, 2);

  if (sourceType === 'bank') {
    const bank = await manager.findOne(Bank, {
      where: {
        id: String(sourceId),
        company_id: String(companyId),
        is_archived: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bank) {
      throw new NotFoundException('Banco no encontrado');
    }
    const balance = toBig(bank.balance);
    if (amountBig.gt(balance)) {
      throw new UnprocessableEntityException(
        `Saldo insuficiente en el banco. Disponible: ${balance.toFixed(2)}`,
      );
    }
    const newBalance = preciseNumber(balance.minus(amountBig), 2);
    await manager.update(
      Bank,
      { id: bank.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    return {
      sourceName: `${bank.name} - ${bank.account_number}`,
      resolvedSourceId: Number(bank.id),
    };
  }

  if (sourceType === 'wallet') {
    const wallet = await manager.findOne(Wallet, {
      where: {
        id: String(sourceId),
        company_id: String(companyId),
        is_archived: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!wallet) {
      throw new NotFoundException('Billetera no encontrada');
    }
    const balance = toBig(wallet.balance);
    if (amountBig.gt(balance)) {
      throw new UnprocessableEntityException(
        `Saldo insuficiente en la billetera. Disponible: ${balance.toFixed(2)}`,
      );
    }
    const newBalance = preciseNumber(balance.minus(amountBig), 2);
    await manager.update(
      Wallet,
      { id: wallet.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    return {
      sourceName: wallet.name,
      resolvedSourceId: Number(wallet.id),
    };
  }

  // sourceType === 'cash_register'
  // El `sourceId` del payload se ignora (paridad PlacePos): solo hay UN turno
  // abierto por company y la action lo resuelve server-side.
  const open = await requireOpenCashRegisterForUpdate(manager, companyId);
  const balanceBig = await computeCashRegisterBalance(manager, open);
  if (amountBig.gt(balanceBig)) {
    throw new UnprocessableEntityException(
      `Saldo insuficiente en la caja. Disponible: ${balanceBig.toFixed(2)}`,
    );
  }
  const log = manager.create(CashRegisterLog, {
    company_id: String(companyId),
    cash_register_id: open.id,
    type: CashRegisterLogType.CASH_OUT,
    direction: 'OUT',
    amount,
    affects_balance: true,
    description: 'Gasto administrativo (egreso de caja)',
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  });
  await manager.save(CashRegisterLog, log);
  return {
    sourceName: 'Caja',
    resolvedSourceId: Number(open.id),
  };
}

/**
 * Operación inversa: acredita la cuenta origen (revertir el gasto). Usado al
 * anular un Expense (soft-delete).
 *
 * - bank/wallet: UPDATE balance += amount, requiriendo que la cuenta siga
 *   activa (rechazo si fue archivada después del gasto — el usuario debe
 *   reactivarla primero, paridad con el comportamiento PlacePos).
 * - cash_register: INSERT CashRegisterLog(direction=IN, type=CASH_IN). El
 *   turno DEBE estar abierto — no se puede revertir un gasto contra un
 *   turno cerrado.
 */
export async function creditExpenseSource(
  manager: EntityManager,
  sourceType: ExpenseSourceType,
  sourceId: number,
  companyId: number,
  amountBig: Big,
  actor: ExpenseActor,
): Promise<void> {
  const amount = preciseNumber(amountBig, 2);

  if (sourceType === 'bank') {
    const bank = await manager.findOne(Bank, {
      where: {
        id: String(sourceId),
        company_id: String(companyId),
        is_archived: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bank) {
      throw new UnprocessableEntityException(
        'No se puede anular el gasto: la cuenta bancaria origen ya no existe o está archivada',
      );
    }
    const newBalance = preciseNumber(toBig(bank.balance).plus(amountBig), 2);
    await manager.update(
      Bank,
      { id: bank.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    return;
  }

  if (sourceType === 'wallet') {
    const wallet = await manager.findOne(Wallet, {
      where: {
        id: String(sourceId),
        company_id: String(companyId),
        is_archived: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!wallet) {
      throw new UnprocessableEntityException(
        'No se puede anular el gasto: la billetera origen ya no existe o está archivada',
      );
    }
    const newBalance = preciseNumber(toBig(wallet.balance).plus(amountBig), 2);
    await manager.update(
      Wallet,
      { id: wallet.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    return;
  }

  // sourceType === 'cash_register'
  const open = await requireOpenCashRegisterForUpdate(manager, companyId);
  const log = manager.create(CashRegisterLog, {
    company_id: String(companyId),
    cash_register_id: open.id,
    type: CashRegisterLogType.CASH_IN,
    direction: 'IN',
    amount,
    affects_balance: true,
    description: 'Reversión de gasto administrativo (ingreso a caja)',
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  });
  await manager.save(CashRegisterLog, log);
}
