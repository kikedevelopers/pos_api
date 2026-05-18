import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { CashRegister } from '../entities/cash-register.entity';

/**
 * Shape de respuesta del endpoint `GET /cash-register/balance`. Espeja
 * PlacePos:
 *   { balance: number, updatedAt: ISO string }
 *
 * Si el actor no tiene caja, devolvemos `balance = 0` y `updatedAt = now()`
 * (firma estable para no romper el frontend).
 */
export interface CashRegisterBalanceResult {
  balance: number;
  updatedAt: string;
}

/**
 * Devuelve el balance corriente de la caja del actor (modelo PERMANENTE).
 *
 * El balance vive en `cash_registers.balance` y se mutea con UPDATE atómico
 * en cada operación que afecta caja. NO se deriva de logs.
 *
 * Read puro — sin transacción. La caja se busca por `(company_id, user_id)`.
 */
@Injectable()
export class GetCashRegisterBalanceAction {
  constructor(
    @InjectRepository(CashRegister)
    private readonly registerRepo: Repository<CashRegister>,
  ) {}

  async execute(companyId: number, userId: number): Promise<CashRegisterBalanceResult> {
    const register = await this.registerRepo.findOne({
      where: { company_id: String(companyId), user_id: String(userId) },
    });

    if (!register) {
      return { balance: 0, updatedAt: new Date().toISOString() };
    }

    return {
      balance: preciseNumber(toBig(register.balance), 2),
      updatedAt: register.updated_at.toISOString(),
    };
  }
}
