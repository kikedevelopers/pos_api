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
