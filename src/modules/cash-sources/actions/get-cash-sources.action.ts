import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { CashSourceItemDto, CashSourcesResponseDto } from '../dto/cash-sources-response.dto';

/**
 * Lista las fuentes de efectivo disponibles para una operación de pago.
 * Espejo de `GET /cash-sources` de PlacePos.
 *
 * Composición (modelo PERMANENTE):
 *   - `wallets`: wallets no archivadas de la company.
 *   - `banks`: banks no archivados de la company.
 *   - `cash_registers`: SOLO la caja del actor `(company_id, user_id)`. Si el
 *     actor no tiene caja, devolvemos arreglo vacío.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class GetCashSourcesAction {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(Bank)
    private readonly bankRepo: Repository<Bank>,
    @InjectRepository(CashRegister)
    private readonly cashRegisterRepo: Repository<CashRegister>,
  ) {}

  async execute(companyId: number, userId: number): Promise<CashSourcesResponseDto> {
    const [wallets, banks, register] = await Promise.all([
      this.walletRepo.find({
        where: { company_id: String(companyId), is_archived: false },
        order: { name: 'ASC' },
      }),
      this.bankRepo.find({
        where: { company_id: String(companyId), is_archived: false },
        order: { name: 'ASC' },
      }),
      this.cashRegisterRepo.findOne({
        where: { company_id: String(companyId), user_id: String(userId) },
      }),
    ]);

    const walletItems: CashSourceItemDto[] = wallets.map((w) => ({
      id: Number(w.id),
      name: w.name,
      balance: preciseNumber(toBig(w.balance), 2),
      type: 'wallet',
    }));

    const bankItems: CashSourceItemDto[] = banks.map((b) => ({
      id: Number(b.id),
      name: b.name,
      balance: preciseNumber(toBig(b.balance), 2),
      type: 'bank',
    }));

    const cashItems: CashSourceItemDto[] = register
      ? [
          {
            id: Number(register.id),
            name: 'Caja',
            balance: preciseNumber(toBig(register.balance), 2),
            type: 'cash_register',
          },
        ]
      : [];

    return {
      wallets: walletItems,
      banks: bankItems,
      cash_registers: cashItems,
    };
  }
}
