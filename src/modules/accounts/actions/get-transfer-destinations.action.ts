import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { User, UserType } from '@/modules/users/entities/user.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { TransferAccountType } from '../dto/transfer.dto';

/**
 * Item de destino disponible para una transferencia. Discriminado por `type`.
 */
export interface TransferDestinationItem {
  id: number;
  name: string;
  balance: number;
  type: 'bank' | 'wallet' | 'user';
}

/**
 * Construye la lista de cuentas destino disponibles cuando se especifica
 * una fuente. Espeja `accounts.routes.ts` de PlacePos:
 *
 *   - Si source = wallet → destinos: otras wallets + bancos + usuarios con
 *     caja registradora (`cash_register`) en la misma company.
 *   - Si source = bank → destinos: otros bancos + wallets.
 *
 * Multi-tenant: todo se filtra por `company_id`. Los usuarios destino se
 * obtienen vía un INNER JOIN con `cash_registers` para garantizar que ya
 * tienen caja (PlacePos hace lo mismo); usuarios `superadmin` no aparecen
 * porque no tienen `company_id`. El `owner` no se autoexcluye — el owner
 * también tiene caja y puede recibir traslados.
 */
@Injectable()
export class GetTransferDestinationsAction {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(Bank)
    private readonly bankRepo: Repository<Bank>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async execute(
    companyId: number,
    sourceType: TransferAccountType,
    sourceId: number,
  ): Promise<{ destinations: TransferDestinationItem[] }> {
    const wallets = await this.walletRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      select: { id: true, name: true, balance: true },
      order: { name: 'ASC' },
    });
    const banks = await this.bankRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      select: { id: true, name: true, balance: true },
      order: { name: 'ASC' },
    });

    const destinations: TransferDestinationItem[] = [];

    if (sourceType === 'wallet') {
      for (const w of wallets) {
        if (Number(w.id) === sourceId) {
          continue;
        }
        destinations.push({
          id: Number(w.id),
          name: w.name,
          balance: Number(w.balance),
          type: 'wallet',
        });
      }
      for (const b of banks) {
        destinations.push({
          id: Number(b.id),
          name: b.name,
          balance: Number(b.balance),
          type: 'bank',
        });
      }

      // Solo se listan usuarios con caja registrada (modelo PlacePos: el
      // INNER JOIN garantiza que la caja existe; el balance mostrado es el
      // de la caja, no el `balance` personal del User). Cualquier user-type
      // dentro de la company es candidato (owner + employees con login
      // habilitado han creado fila espejo en `users`).
      const usersWithRegister = await this.userRepo
        .createQueryBuilder('u')
        .innerJoin(CashRegister, 'cr', 'cr.user_id = u.id AND cr.company_id = u.company_id')
        .where('u.company_id = :companyId', { companyId: String(companyId) })
        .andWhere('u.type != :superadmin', { superadmin: UserType.SUPERADMIN })
        .select(['u.id AS id', 'u.name AS name', 'u.lastname AS lastname', 'cr.balance AS balance'])
        .orderBy('u.name', 'ASC')
        .getRawMany<{ id: string; name: string; lastname: string; balance: string | number }>();

      for (const u of usersWithRegister) {
        destinations.push({
          id: Number(u.id),
          name: `${u.name ?? ''} ${u.lastname ?? ''}`.trim() || 'Usuario',
          balance: Number(u.balance),
          type: 'user',
        });
      }
    } else {
      for (const b of banks) {
        if (Number(b.id) === sourceId) {
          continue;
        }
        destinations.push({
          id: Number(b.id),
          name: b.name,
          balance: Number(b.balance),
          type: 'bank',
        });
      }
      for (const w of wallets) {
        destinations.push({
          id: Number(w.id),
          name: w.name,
          balance: Number(w.balance),
          type: 'wallet',
        });
      }
    }

    return { destinations };
  }
}
