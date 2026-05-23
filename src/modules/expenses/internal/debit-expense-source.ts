import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type Big from 'big.js';
import type { EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { ExpenseSourceType } from '../entities/expense.entity';

/**
 * Actor (snapshot del usuario que origina el gasto). Mismo shape que en
 * `purchase-payment.action`/`sale-payment.action` para consistencia.
 *
 * Para fuentes `cash_register`, el `id` del actor se usa como `user_id` que
 * resuelve la caja PERMANENTE.
 */
export interface ExpenseActor {
  id: number;
  fullName: string;
}

/**
 * Resultado de debitar la fuente: nombre legible (snapshot) y, para
 * cash_register, el id del row resuelto (el del actor — PlacePos ignora el
 * source_id del payload).
 */
export interface DebitExpenseSourceResult {
  /** Snapshot del nombre — guardado en `Expense.source_name`. */
  sourceName: string;
  /** ID resuelto: el del cash_register del actor si source_type=cash_register; sino igual al payload. */
  resolvedSourceId: number;
}

/**
 * Debita el monto de la cuenta origen con lock pessimistic_write. Aborta con:
 *   - `NotFoundException` si la cuenta no existe en la company o está archivada.
 *   - `UnprocessableEntityException` si el balance es insuficiente.
 *
 * Patrón espejo de `register-purchase-payment.action.debitSource`. Encapsulado
 * en helper porque se reusa entre `CreateExpenseAction` (debita) y la
 * acreditación del soft-delete (`creditExpenseSource`).
 *
 * **Lock pessimistic_write**: dos gastos concurrentes contra la misma cuenta
 * serializan en el lock; el segundo re-lee el balance tras el commit del
 * primero.
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
  // El `sourceId` del payload se ignora (paridad PlacePos): la caja del actor
  // se resuelve por user_id server-side.
  const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
  const balance = toBig(register.balance);
  if (amountBig.gt(balance)) {
    throw new UnprocessableEntityException(
      `Saldo insuficiente en la caja. Disponible: ${balance.toFixed(2)}`,
    );
  }
  const newBalance = preciseNumber(balance.minus(amountBig), 2);
  await manager.update(
    CashRegister,
    { id: register.id, company_id: String(companyId) },
    { balance: newBalance },
  );
  const log = manager.create(CashRegisterLog, {
    company_id: String(companyId),
    cash_register_id: register.id,
    type: CashRegisterLogType.EXPENSE,
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
    resolvedSourceId: Number(register.id),
  };
}

/**
 * Operación inversa: acredita la cuenta origen (revertir el gasto). Usado al
 * anular un Expense (soft-delete).
 *
 * - bank/wallet: UPDATE balance += amount, requiriendo que la cuenta siga
 *   activa (rechazo si fue archivada después del gasto — el usuario debe
 *   reactivarla primero, paridad PlacePos).
 * - cash_register: UPDATE register.balance += amount + INSERT log VOID_EXPENSE
 *   contra la **caja original que registró el gasto** (I-10). NO la del
 *   actor que anula: el dinero debe regresar a su origen real. Si la caja
 *   ya no existe (eliminación física del usuario), se lanza 422
 *   NO_ORIGINAL_REGISTER para forzar conciliación manual.
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
  // I-10: la reversión se hace contra la caja ORIGINAL que registró el
  // gasto (`expense.source_id`), no la del actor que anula. El dinero
  // debe regresar al lugar de donde salió.
  //
  // - Si la caja original ya no existe (user archivado / row borrado), no
  //   podemos elegir un destino arbitrario sin descuadrar la conciliación
  //   — lanzamos 422 NO_ORIGINAL_REGISTER.
  // - El log se firma con el actor que anula (created_by) para auditoría;
  //   la fila apunta a la caja original via `cash_register_id`.
  const originalRegister = await manager.findOne(CashRegister, {
    where: { id: String(sourceId), company_id: String(companyId) },
    lock: { mode: 'pessimistic_write' },
  });
  if (!originalRegister) {
    throw new UnprocessableEntityException({
      message:
        'No se puede anular el gasto: la caja registradora original ya no existe. ' +
        'Reconcilia manualmente.',
      payload: { code: 'NO_ORIGINAL_REGISTER' },
    });
  }
  const newBalance = preciseNumber(toBig(originalRegister.balance).plus(amountBig), 2);
  await manager.update(
    CashRegister,
    { id: originalRegister.id, company_id: String(companyId) },
    { balance: newBalance },
  );
  const log = manager.create(CashRegisterLog, {
    company_id: String(companyId),
    cash_register_id: originalRegister.id,
    type: CashRegisterLogType.VOID_EXPENSE,
    direction: 'IN',
    amount,
    affects_balance: true,
    description: 'Reversión de gasto administrativo (ingreso a caja)',
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  });
  await manager.save(CashRegisterLog, log);
}
