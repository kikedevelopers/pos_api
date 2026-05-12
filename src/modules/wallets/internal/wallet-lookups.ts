import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Wallet } from '@/modules/wallets/entities/wallet.entity';

/**
 * Lookup wallet por id dentro de una company.
 *
 * Lanza `NotFoundException` si no existe O pertenece a otra company.
 * Mensaje genérico anti-enumeración.
 *
 * Si `requireActive = true`, filtra `is_archived = false`.
 */
export async function findWalletInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { requireActive?: boolean } = {},
): Promise<Wallet> {
  const where: { id: string; company_id: string; is_archived?: boolean } = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.requireActive === true) {
    where.is_archived = false;
  }

  const wallet = await manager.findOne(Wallet, { where });
  if (!wallet) {
    throw new NotFoundException('Billetera no encontrada');
  }
  return wallet;
}
