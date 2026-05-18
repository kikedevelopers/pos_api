import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';

/**
 * Output de `GET /pos-data/cash-summary` — paridad byte-por-byte con PlacePos.
 *
 *   - `balance`: saldo corriente del sistema en la caja del actor.
 *   - `base_amount`: fondo fijo configurado por el owner.
 *   - `available_to_move`: max(0, balance - base_amount). Lo que el cajero
 *     puede trasladar antes de tocar el fondo fijo.
 *
 * Si el actor no tiene caja todavía (modelo PERMANENTE: la caja se crea on
 * demand al primer movimiento), devolvemos los tres campos en 0.
 */
export interface CashSummaryResult {
  balance: number;
  base_amount: number;
  available_to_move: number;
}

/**
 * `GET /pos-data/cash-summary`. SELECT puro, sin transacción.
 *
 * Multi-tenancy: filtra por `(company_id, user_id)`.
 */
@Injectable()
export class GetCashSummaryAction {
  constructor(
    @InjectRepository(CashRegister)
    private readonly registerRepo: Repository<CashRegister>,
  ) {}

  async execute(companyId: number, userId: number): Promise<CashSummaryResult> {
    const register = await this.registerRepo.findOne({
      where: {
        company_id: String(companyId),
        user_id: String(userId),
      },
      select: { id: true, balance: true, base_amount: true },
    });

    const balance = register ? preciseNumber(toBig(register.balance), 2) : 0;
    const baseAmount = register ? preciseNumber(toBig(register.base_amount), 2) : 0;
    const availableBig = toBig(balance).minus(toBig(baseAmount));
    const availableToMove = availableBig.lt(0) ? 0 : preciseNumber(availableBig, 2);

    return {
      balance,
      base_amount: baseAmount,
      available_to_move: availableToMove,
    };
  }
}
