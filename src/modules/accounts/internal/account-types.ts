import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { TransferAccountType } from '../dto/transfer.dto';

/**
 * Helpers internos del módulo `accounts`. Centralizan la lectura/escritura
 * de balances polimórficos (bank | wallet). El service inyecta el
 * `EntityManager` para que toda la transferencia viva en UNA transacción.
 */

export interface AccountSnapshot {
  id: number;
  name: string;
  balance: number;
}

/**
 * Carga el row de origen/destino DENTRO de una company. Lanza
 * `NotFoundException` si no existe o pertenece a otra company. Activo
 * (`is_archived = false`) requerido — no se puede transferir desde/hacia
 * cuentas archivadas.
 *
 * **Lock pessimistic_write (CRIT-1 auditoría)**: el SELECT incluye
 * `FOR UPDATE`, serializando lecturas concurrentes del mismo row. Sin esto,
 * dos transferencias concurrentes desde la misma cuenta con balance=100
 * podrían leer ambas el valor antiguo, validar ambas `100>=60` y dejar el
 * balance en 40 cuando debería ser -20 (oversell). Postgres bloquea la
 * segunda transacción hasta que la primera haga COMMIT/ROLLBACK.
 *
 * Requiere que el caller esté dentro de `dataSource.transaction(...)` —
 * de lo contrario TypeORM lanza error. Todos los callers actuales
 * (TransferAction) ya están dentro de una transacción.
 */
export async function loadAccountInCompany(
  manager: EntityManager,
  type: TransferAccountType,
  id: number,
  companyId: number,
  role: 'source' | 'destination',
): Promise<AccountSnapshot> {
  if (type === 'wallet') {
    const wallet = await manager.findOne(Wallet, {
      where: {
        id: String(id),
        company_id: String(companyId),
        is_archived: false,
      },
      select: { id: true, name: true, balance: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!wallet) {
      throw new NotFoundException(
        role === 'source' ? 'Cuenta origen no encontrada' : 'Cuenta destino no encontrada',
      );
    }
    return { id: Number(wallet.id), name: wallet.name, balance: Number(wallet.balance) };
  }

  const bank = await manager.findOne(Bank, {
    where: {
      id: String(id),
      company_id: String(companyId),
      is_archived: false,
    },
    select: { id: true, name: true, balance: true },
    lock: { mode: 'pessimistic_write' },
  });
  if (!bank) {
    throw new NotFoundException(
      role === 'source' ? 'Cuenta origen no encontrada' : 'Cuenta destino no encontrada',
    );
  }
  return { id: Number(bank.id), name: bank.name, balance: Number(bank.balance) };
}

/**
 * Actualiza el balance de una cuenta (bank | wallet) DENTRO de la
 * transacción. El caller debe haber validado que la cuenta existe y
 * pertenece a la company.
 */
export async function setAccountBalance(
  manager: EntityManager,
  type: TransferAccountType,
  id: number,
  companyId: number,
  newBalance: number,
): Promise<void> {
  if (type === 'wallet') {
    await manager.update(
      Wallet,
      { id: String(id), company_id: String(companyId) },
      { balance: newBalance },
    );
    return;
  }
  await manager.update(
    Bank,
    { id: String(id), company_id: String(companyId) },
    { balance: newBalance },
  );
}

/**
 * Rechaza transferencias source === destination (mismo tipo y mismo id) —
 * sería ruido en `financial_movements` y un sobrecargo innecesario.
 */
export function ensureDifferentAccounts(
  sourceType: TransferAccountType,
  sourceId: number,
  destinationType: TransferAccountType,
  destinationId: number,
): void {
  if (sourceType === destinationType && sourceId === destinationId) {
    throw new UnprocessableEntityException('La cuenta origen y destino no pueden ser la misma');
  }
}
