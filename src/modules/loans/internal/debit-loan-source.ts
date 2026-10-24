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

import type { LoanSourceType } from '../entities/loan.entity';

export interface LoanActor {
  id: number;
  fullName: string;
}

export interface DebitLoanSourceResult {
  /** Snapshot del nombre de la cuenta (`loans.source_name`). */
  sourceName: string;
  /** Id real: el de la caja del actor si es caja; si no, el del payload. */
  resolvedSourceId: number;
}

/**
 * Saca el dinero prestado de la cuenta origen, con lock `pessimistic_write`
 * (dos préstamos contra la misma cuenta se serializan y el segundo re-lee el
 * saldo). Mismo patrón que `debitExpenseSource`, pero registrando el egreso
 * como DESEMBOLSO DE PRÉSTAMO, no como gasto.
 *
 *   - 404 si la cuenta no existe en la company o está archivada.
 *   - 422 si el saldo no alcanza (no se presta plata que no hay).
 *   - Caja: la del ACTOR (resuelta server-side; el `sourceId` del payload se
 *     ignora, como en gastos) + log `LOAN_DISBURSEMENT` OUT.
 *   - Banco / billetera: solo baja el saldo; el movimiento financiero lo
 *     registra la action con el `reference_code` del préstamo.
 */
export async function debitLoanSource(
  manager: EntityManager,
  sourceType: LoanSourceType,
  sourceId: number | undefined,
  companyId: number,
  amountBig: Big,
  description: string,
  actor: LoanActor,
): Promise<DebitLoanSourceResult> {
  const amount = preciseNumber(amountBig, 2);

  if (sourceType === 'bank' || sourceType === 'wallet') {
    if (sourceId === undefined) {
      throw new NotFoundException(sourceType === 'bank' ? 'Banco no encontrado' : 'Billetera no encontrada');
    }
    const entity = sourceType === 'bank' ? Bank : Wallet;
    const account = (await manager.findOne(entity, {
      where: { id: String(sourceId), company_id: String(companyId), is_archived: false },
      lock: { mode: 'pessimistic_write' },
    })) as (Bank | Wallet) | null;
    if (!account) {
      throw new NotFoundException(sourceType === 'bank' ? 'Banco no encontrado' : 'Billetera no encontrada');
    }
    const balance = toBig(account.balance);
    if (amountBig.gt(balance)) {
      throw new UnprocessableEntityException(
        `Saldo insuficiente en ${sourceType === 'bank' ? 'el banco' : 'la billetera'}. Disponible: ${balance.toFixed(2)}`,
      );
    }
    await manager.update(
      entity,
      { id: account.id, company_id: String(companyId) },
      { balance: preciseNumber(balance.minus(amountBig), 2) },
    );
    const sourceName =
      sourceType === 'bank'
        ? `${(account as Bank).name} - ${(account as Bank).account_number}`
        : (account as Wallet).name;
    return { sourceName, resolvedSourceId: Number(account.id) };
  }

  const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
  const balance = toBig(register.balance);
  if (amountBig.gt(balance)) {
    throw new UnprocessableEntityException(
      `Saldo insuficiente en la caja. Disponible: ${balance.toFixed(2)}`,
    );
  }
  await manager.update(
    CashRegister,
    { id: register.id, company_id: String(companyId) },
    { balance: preciseNumber(balance.minus(amountBig), 2) },
  );
  await manager.save(
    CashRegisterLog,
    manager.create(CashRegisterLog, {
      company_id: String(companyId),
      cash_register_id: register.id,
      type: CashRegisterLogType.LOAN_DISBURSEMENT,
      direction: 'OUT',
      amount,
      affects_balance: true,
      description,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    }),
  );
  return { sourceName: 'Caja', resolvedSourceId: Number(register.id) };
}
