import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { TransferAccountType } from '../dto/transfer.dto';

/**
 * Item de destino disponible para una transferencia.
 */
export interface TransferDestinationItem {
  id: number;
  name: string;
  balance: number;
  type: 'bank' | 'wallet';
}

/**
 * Construye la lista de cuentas destino disponibles cuando se especifica
 * una fuente. Espeja `accounts.routes.ts` de PlacePos:
 *
 *   - Si source = wallet → destinos: other wallets + all banks.
 *   - Si source = bank → destinos: other banks + all wallets.
 *
 * No incluye destinos tipo `user` — el modelo cloud no tiene "caja
 * personal de usuario" (la caja es por turno, no por usuario). Documentado
 * como divergencia.
 */
@Injectable()
export class GetTransferDestinationsAction {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(Bank)
    private readonly bankRepo: Repository<Bank>,
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
