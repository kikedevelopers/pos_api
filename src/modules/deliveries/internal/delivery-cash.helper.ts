import { UnprocessableEntityException } from '@nestjs/common';
import type Big from 'big.js';
import type { EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';

/**
 * Actor (snapshot del usuario que registra el domicilio). Mismo shape que en
 * `expenses` (`ExpenseActor`) para consistencia. El `id` se usa como
 * `user_id` que resuelve la caja PERMANENTE.
 */
export interface DeliveryActor {
  id: number;
  fullName: string;
}

/**
 * Debita el `amount` de la caja del actor (egreso por domicilio pagado de
 * caja) e inserta un `CashRegisterLog(DELIVERY_PAYMENT, OUT)`.
 *
 * Patrón espejo de `debit-expense-source.ts` (rama `cash_register`):
 *
 *   1. `getOrCreateCashRegisterForUser` (lock pessimistic_write).
 *   2. Validar `balance >= amount` → si no, 422 'Saldo insuficiente en la caja.'
 *      (mensaje EXACTO del contrato Domiciliarios).
 *   3. UPDATE balance -= amount.
 *   4. INSERT CashRegisterLog(DELIVERY_PAYMENT, OUT, affects_balance=true,
 *      description `Domicilio: <delivery_company_name>`).
 *
 * Debe invocarse SIEMPRE dentro de `dataSource.transaction(...)`.
 *
 * @returns el id del CashRegisterLog insertado (para enlazarlo al Delivery).
 */
export async function debitCashForDelivery(
  manager: EntityManager,
  companyId: number,
  amountBig: Big,
  deliveryCompanyName: string,
  actor: DeliveryActor,
): Promise<{ cashRegisterLogId: number }> {
  const amount = preciseNumber(amountBig, 2);

  const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
  const balance = toBig(register.balance);
  if (amountBig.gt(balance)) {
    // Mensaje EXACTO del contrato Domiciliarios.
    throw new UnprocessableEntityException('Saldo insuficiente en la caja.');
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
    type: CashRegisterLogType.DELIVERY_PAYMENT,
    direction: 'OUT',
    amount,
    affects_balance: true,
    description: `Domicilio: ${deliveryCompanyName}`,
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  });
  const savedLog = await manager.save(CashRegisterLog, log);

  return { cashRegisterLogId: Number(savedLog.id) };
}

/**
 * Operación inversa: revierte el egreso de un domicilio pagado de caja
 * (ingreso a caja). Usado al archivar un Delivery con
 * `payment_method = 'cash_register'`.
 *
 * La reversión se hace contra la caja ORIGINAL que registró el egreso
 * (resuelta vía el `CashRegisterLog` original), no la del actor que archiva —
 * el dinero debe regresar a su origen real (mismo invariante que `expenses`).
 *
 *   1. Cargar el log original (dentro del tenant) → de él obtenemos la caja Y
 *      el monto exacto del egreso.
 *   2. Lock pessimistic_write sobre esa caja. Si ya no existe → 422.
 *   3. UPDATE balance += amount.
 *   4. INSERT CashRegisterLog(VOID_DELIVERY_PAYMENT, IN, affects_balance=true).
 *
 * IMPORTANTE: el monto a revertir se toma del `CashRegisterLog` ORIGINAL
 * (`originalLog.amount`), NO del `Delivery.amount`. Así la reversión devuelve
 * exactamente lo que salió de la caja aunque, en una evolución futura, se
 * permitiera editar el monto del domicilio después de registrado: el balance
 * de la caja siempre cuadra contra su propio movimiento de egreso.
 */
export async function reverseCashForDelivery(
  manager: EntityManager,
  companyId: number,
  cashRegisterLogId: number,
  deliveryCompanyName: string,
  actor: DeliveryActor,
): Promise<void> {
  const originalLog = await manager.findOne(CashRegisterLog, {
    where: { id: String(cashRegisterLogId), company_id: String(companyId) },
  });
  if (!originalLog) {
    throw new UnprocessableEntityException(
      'No se puede anular el domicilio: el movimiento de caja original ya no existe. ' +
        'Reconcilia manualmente.',
    );
  }

  // Monto exacto del egreso original (no el del Delivery, que podría diverger
  // en el futuro si se permitiera editarlo).
  const amountBig = toBig(originalLog.amount);
  const amount = preciseNumber(amountBig, 2);

  const originalRegister = await manager.findOne(CashRegister, {
    where: { id: originalLog.cash_register_id, company_id: String(companyId) },
    lock: { mode: 'pessimistic_write' },
  });
  if (!originalRegister) {
    throw new UnprocessableEntityException(
      'No se puede anular el domicilio: la caja registradora original ya no existe. ' +
        'Reconcilia manualmente.',
    );
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
    type: CashRegisterLogType.VOID_DELIVERY_PAYMENT,
    direction: 'IN',
    amount,
    affects_balance: true,
    description: `Reversión de domicilio: ${deliveryCompanyName}`,
    created_by: actor.fullName,
    created_by_id: String(actor.id),
  });
  await manager.save(CashRegisterLog, log);
}
