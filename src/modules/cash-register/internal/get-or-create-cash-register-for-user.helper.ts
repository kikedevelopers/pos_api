import type { EntityManager } from 'typeorm';

import { CashRegister } from '../entities/cash-register.entity';

/**
 * Resuelve la caja PERMANENTE de un (`company_id`, `user_id`).
 *
 * --------------------------------------------------------------------------
 * Semántica
 * --------------------------------------------------------------------------
 *
 *   1. SELECT por `(company_id, user_id)` con lock pessimistic_write.
 *   2. Si existe, devolverlo bloqueado.
 *   3. Si NO existe, INSERT con `balance=0, base_amount=0` y devolverlo.
 *
 * --------------------------------------------------------------------------
 * Concurrencia
 * --------------------------------------------------------------------------
 *
 * El UNIQUE parcial `(company_id, user_id) WHERE user_id IS NOT NULL` blinda
 * la unicidad. Si dos transacciones intentan INSERT al mismo tiempo, una gana
 * y la otra recibe `unique_violation` (23505); en ese caso re-leemos para
 * obtener el row del ganador. La función siempre retorna el row con lock
 * activo, listo para mutar `balance`.
 *
 * --------------------------------------------------------------------------
 * Uso
 * --------------------------------------------------------------------------
 *
 * Debe invocarse SIEMPRE dentro de `dataSource.transaction(...)` — el lock
 * solo es efectivo dentro de la transacción.
 *
 *     await dataSource.transaction(async (manager) => {
 *       const register = await getOrCreateCashRegisterForUser(manager, companyId, userId);
 *       // ... mutar register.balance con UPDATE ...
 *     });
 */
export async function getOrCreateCashRegisterForUser(
  manager: EntityManager,
  companyId: number,
  userId: number,
): Promise<CashRegister> {
  const existing = await manager.findOne(CashRegister, {
    where: {
      company_id: String(companyId),
      user_id: String(userId),
    },
    lock: { mode: 'pessimistic_write' },
  });
  if (existing) {
    return existing;
  }

  // No existe: INSERT atómico. El UNIQUE parcial es el latch contra carreras.
  const entity = manager.create(CashRegister, {
    company_id: String(companyId),
    user_id: String(userId),
    balance: 0,
    base_amount: 0,
  });
  try {
    return await manager.save(CashRegister, entity);
  } catch (error) {
    // Re-leer para el ganador en caso de race (UNIQUE violation 23505).
    const winner = await manager.findOne(CashRegister, {
      where: {
        company_id: String(companyId),
        user_id: String(userId),
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (winner) {
      return winner;
    }
    throw error;
  }
}
