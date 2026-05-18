import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

/**
 * Shape de respuesta de `GET /expenses/payment-methods`. Espejo del payload
 * que sirve PlacePos `/cash-sources` (reusado por `expenses.routes.ts`).
 */
export interface ExpensePaymentMethodsResponse {
  wallets: Array<{
    id: number;
    name: string;
    balance: number;
  }>;
  banks: Array<{
    id: number;
    name: string;
    account_number: string;
    balance: number;
  }>;
  cash_registers: Array<{
    id: number;
    balance: number;
  }>;
}

/**
 * Devuelve las fuentes de pago disponibles para registrar un gasto (modelo
 * PERMANENTE):
 *
 *   - Wallets activos (`is_archived = false`).
 *   - Banks activos.
 *   - Caja registradora: SOLO la caja del actor `(company_id, user_id)`.
 *     Si el actor no tiene caja, se devuelve un array vacío.
 *
 * Multi-tenancy: todo filtrado por `company_id` recibido del JWT.
 *
 * Read puro fuera de transacción.
 */
@Injectable()
export class GetExpensePaymentMethodsAction {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(Bank)
    private readonly bankRepo: Repository<Bank>,
    @InjectRepository(CashRegister)
    private readonly cashRegisterRepo: Repository<CashRegister>,
  ) {}

  async execute(companyId: number, userId: number): Promise<ExpensePaymentMethodsResponse> {
    const [wallets, banks, register] = await Promise.all([
      this.walletRepo.find({
        where: { company_id: String(companyId), is_archived: false },
        order: { created_at: 'DESC' },
      }),
      this.bankRepo.find({
        where: { company_id: String(companyId), is_archived: false },
        order: { created_at: 'DESC' },
      }),
      this.cashRegisterRepo.findOne({
        where: { company_id: String(companyId), user_id: String(userId) },
      }),
    ]);

    const cashRegisters: ExpensePaymentMethodsResponse['cash_registers'] = register
      ? [
          {
            id: Number(register.id),
            balance: preciseNumber(toBig(register.balance), 2),
          },
        ]
      : [];

    return {
      wallets: wallets.map((w) => ({
        id: Number(w.id),
        name: w.name,
        balance: Number(w.balance),
      })),
      banks: banks.map((b) => ({
        id: Number(b.id),
        name: b.name,
        account_number: b.account_number,
        balance: Number(b.balance),
      })),
      cash_registers: cashRegisters,
    };
  }
}
