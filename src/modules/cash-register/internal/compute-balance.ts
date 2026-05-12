import type Big from 'big.js';
import type { EntityManager } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import { CashRegisterLog } from '../entities/cash-register-log.entity';
import type { CashRegister } from '../entities/cash-register.entity';

/**
 * Calcula el balance corriente de un turno de caja DENTRO de una transacción
 * dada por el caller. Usa el `EntityManager` pasado para que el SELECT de logs
 * vea el snapshot consistente con el resto de operaciones de la transacción
 * (lock del row del cash_register adquirido previamente, etc).
 *
 * **Por qué este helper existe (CRIT-1 auditoría)**: la action pública
 * `GetCashRegisterBalanceAction` inyecta repos del default pool — fuera de
 * cualquier transacción del caller. Usarla desde dentro de un
 * `dataSource.transaction` (ej. `register-purchase-payment`) leería un
 * snapshot autocommit que ignora el lock pessimistic adquirido sobre el
 * cash_register: dos pagos concurrentes desde la misma caja podían validar
 * ambos `balance >= amount` y dejar el balance negativo. Este helper resuelve
 * el problema obligando al caller a pasar el `manager` transaccional.
 *
 * Fórmula: `opening_balance + Σ amount(IN, affects_balance=true) -
 *           Σ amount(OUT, affects_balance=true)`.
 *
 * Cálculo con Big.js. El resultado se redondea a 2 decimales al final.
 */
export async function computeCashRegisterBalance(
  manager: EntityManager,
  register: Pick<CashRegister, 'id' | 'company_id' | 'opening_balance'>,
): Promise<Big> {
  const logs = await manager.find(CashRegisterLog, {
    where: {
      cash_register_id: register.id,
      company_id: register.company_id,
      affects_balance: true,
    },
  });

  let balance: Big = toBig(register.opening_balance);
  for (const log of logs) {
    const amount = toBig(log.amount);
    if (log.direction === 'IN') {
      balance = balance.plus(amount);
    } else {
      balance = balance.minus(amount);
    }
  }
  return balance;
}
