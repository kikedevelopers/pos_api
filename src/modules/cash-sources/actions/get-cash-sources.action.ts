import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { User } from '@/modules/users/entities/user.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { CashSourceItemDto, CashSourcesResponseDto } from '../dto/cash-sources-response.dto';

/**
 * Lista las fuentes de efectivo disponibles para una operación de pago.
 * Espejo de la lógica de PlacePos en `expenses.routes.ts → GET /payment-methods`,
 * que es la referencia funcional del concepto "fuentes disponibles":
 *
 *   - `wallets`: wallets no archivadas de la company (id, name, balance).
 *   - `banks`: banks no archivados; `name = "${name} - ${account_number}"`
 *     (paridad byte-por-byte — el frontend espera ese formato concatenado).
 *   - `cash_registers`: SOLO la caja del actor. Si existe, `name = "Caja de
 *     ${name} ${lastname}"`. Si NO existe, devolvemos un placeholder con
 *     `id: 0` y `balance: 0` (paridad PlacePos: el selector siempre muestra
 *     la fila de "Caja" aunque el primer movimiento la cree).
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
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async execute(companyId: number, userId: number): Promise<CashSourcesResponseDto> {
    const [wallets, banks, register, actor] = await Promise.all([
      this.walletRepo.find({
        where: { company_id: String(companyId), is_archived: false },
        select: { id: true, name: true, balance: true },
        order: { name: 'ASC' },
      }),
      this.bankRepo.find({
        where: { company_id: String(companyId), is_archived: false },
        select: { id: true, name: true, account_number: true, balance: true },
        order: { name: 'ASC' },
      }),
      this.cashRegisterRepo.findOne({
        where: { company_id: String(companyId), user_id: String(userId) },
        select: { id: true, balance: true },
      }),
      this.userRepo.findOne({
        where: { id: String(userId) },
        select: { name: true, lastname: true },
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
      name: `${b.name} - ${b.account_number}`,
      balance: preciseNumber(toBig(b.balance), 2),
      type: 'bank',
    }));

    // El actor puede ser un Employee que aún no tiene fila espejo en `users`,
    // en cuyo caso usamos un nombre genérico. Tampoco rompemos si el row de
    // users existe pero el nombre/lastname son null por algún drift legacy.
    const fullName = actor ? `${actor.name ?? ''} ${actor.lastname ?? ''}`.trim() : '';
    const cashLabel = fullName ? `Caja de ${fullName}` : 'Caja';

    const cashItems: CashSourceItemDto[] = register
      ? [
          {
            id: Number(register.id),
            name: cashLabel,
            balance: preciseNumber(toBig(register.balance), 2),
            type: 'cash_register',
          },
        ]
      : [
          // Placeholder con id=0 — paridad PlacePos. El frontend sustituye este
          // id por la caja real cuando ocurre el primer movimiento (lo crea
          // `getOrCreateCashRegisterForUser` dentro de la transacción del
          // flujo que lo dispara, e.g. expenses.create con source_type=
          // cash_register).
          {
            id: 0,
            name: cashLabel,
            balance: 0,
            type: 'cash_register',
          },
        ];

    return {
      wallets: walletItems,
      banks: bankItems,
      cash_registers: cashItems,
    };
  }
}
