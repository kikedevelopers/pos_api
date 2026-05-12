import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Big from 'big.js';
import { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { CashRegisterLog, CashRegisterLogDirection } from '../entities/cash-register-log.entity';
import { CashRegister, CashRegisterStatus } from '../entities/cash-register.entity';

/**
 * Shape de respuesta del endpoint `GET /cash-register/balance`. Espeja
 * PlacePos:
 *   { balance: number, updatedAt: ISO string }
 *
 * Cuando no hay turno abierto, devolvemos `balance = 0` y
 * `updatedAt = now()` (la firma debe ser estable para no romper el
 * frontend).
 */
export interface CashRegisterBalanceResult {
  balance: number;
  updatedAt: string;
}

/**
 * Calcula el balance corriente del turno abierto. Espejo del endpoint
 * `GET /cash-register/balance` de PlacePos.
 *
 * Fórmula: `opening_balance + Σ amount(IN, affects_balance=true)
 *                          - Σ amount(OUT, affects_balance=true)`.
 *
 * Cálculo con Big.js. Si no hay turno abierto, balance = 0.
 *
 * Read puro — no requiere transacción. NOTA: si dos lecturas concurrentes
 * incluyen escrituras intercaladas de logs, el balance puede variar entre
 * reads. Es la misma semántica que tendría PlacePos (no garantiza
 * snapshot fuera de transacción explícita).
 */
@Injectable()
export class GetCashRegisterBalanceAction {
  constructor(
    @InjectRepository(CashRegister)
    private readonly registerRepo: Repository<CashRegister>,
    @InjectRepository(CashRegisterLog)
    private readonly logRepo: Repository<CashRegisterLog>,
  ) {}

  async execute(companyId: number): Promise<CashRegisterBalanceResult> {
    const register = await this.registerRepo.findOne({
      where: { company_id: String(companyId), status: CashRegisterStatus.OPEN },
    });

    if (!register) {
      return { balance: 0, updatedAt: new Date().toISOString() };
    }

    const logs = await this.logRepo.find({
      where: {
        cash_register_id: register.id,
        company_id: String(companyId),
        affects_balance: true,
      },
    });

    let balance: Big = toBig(register.opening_balance);
    for (const log of logs) {
      const amount = toBig(log.amount);
      const direction: CashRegisterLogDirection = log.direction;
      if (direction === 'IN') {
        balance = balance.plus(amount);
      } else {
        balance = balance.minus(amount);
      }
    }

    return {
      balance: preciseNumber(balance, 2),
      updatedAt: register.updated_at.toISOString(),
    };
  }
}
