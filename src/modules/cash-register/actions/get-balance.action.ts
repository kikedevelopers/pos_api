import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { CashRegister } from '../entities/cash-register.entity';

/**
 * Shape de respuesta del endpoint `GET /cash-register/balance`. Espeja
 * PlacePos byte-por-byte:
 *
 *   { balance: number, baseAmount: number, updatedAt: ISO string }
 *
 * `baseAmount` representa el fondo fijo de la caja (configurado por el owner).
 * Si el actor no tiene caja todavía, devolvemos zeros + `updatedAt = now()` —
 * firma estable para no romper el frontend cuando un empleado nuevo consulta
 * antes de su primer movimiento.
 */
export interface CashRegisterBalanceResult {
  balance: number;
  baseAmount: number;
  updatedAt: string;
}

/**
 * Devuelve el balance corriente + fondo base de la caja del actor (modelo
 * PERMANENTE).
 *
 * El balance vive en `cash_registers.balance` y se mutea con UPDATE atómico
 * en cada operación que afecta caja. NO se deriva de logs. El `base_amount`
 * es informativo y se setea aparte (no se altera por operaciones de venta).
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
      select: { id: true, balance: true, base_amount: true, updated_at: true },
    });

    if (!register) {
      return { balance: 0, baseAmount: 0, updatedAt: new Date().toISOString() };
    }

    return {
      balance: preciseNumber(toBig(register.balance), 2),
      baseAmount: preciseNumber(toBig(register.base_amount), 2),
      updatedAt: register.updated_at.toISOString(),
    };
  }
}
