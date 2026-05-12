import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { CashRegister, CashRegisterStatus } from '../entities/cash-register.entity';

/**
 * Devuelve el turno actualmente abierto para una company, o `null` si no
 * hay ninguno. El UNIQUE parcial garantiza que esta query devuelva como
 * máximo un row.
 */
export async function findOpenCashRegister(
  manager: EntityManager,
  companyId: number,
): Promise<CashRegister | null> {
  return manager.findOne(CashRegister, {
    where: { company_id: String(companyId), status: CashRegisterStatus.OPEN },
  });
}

/**
 * Idéntico al anterior pero exige existencia: lanza NotFoundException si
 * no hay turno abierto. Usado por `/close`, `/current` y operaciones que
 * requieren caja abierta.
 */
export async function requireOpenCashRegister(
  manager: EntityManager,
  companyId: number,
): Promise<CashRegister> {
  const open = await findOpenCashRegister(manager, companyId);
  if (!open) {
    throw new NotFoundException('No hay caja abierta');
  }
  return open;
}

/**
 * Versión con SELECT ... FOR UPDATE. Lanza NotFoundException si no hay turno
 * abierto y bloquea el row en la transacción actual.
 *
 * **HIGH-6 auditoría**: el cierre de caja calcula `expected_balance` a partir
 * de los logs del turno. Sin lock, un INSERT concurrente en
 * `cash_register_logs` entre el SELECT de logs y el UPDATE final dejaría
 * logs huérfanos (turno cerrado con `expected_balance` que no los contó). Al
 * lockear el row del cash_register con FOR UPDATE, otras transacciones que
 * intenten insertar logs `affects_balance=true` (que típicamente leen primero
 * el cash_register para validar status='open') quedan bloqueadas hasta que
 * el cierre commitee o haga rollback.
 *
 * Debe invocarse desde dentro de `dataSource.transaction(...)`.
 */
export async function requireOpenCashRegisterForUpdate(
  manager: EntityManager,
  companyId: number,
): Promise<CashRegister> {
  const open = await manager.findOne(CashRegister, {
    where: { company_id: String(companyId), status: CashRegisterStatus.OPEN },
    lock: { mode: 'pessimistic_write' },
  });
  if (!open) {
    throw new NotFoundException('No hay caja abierta');
  }
  return open;
}
