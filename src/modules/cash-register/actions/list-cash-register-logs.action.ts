import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CashRegisterLog } from '../entities/cash-register-log.entity';
import { CashRegister } from '../entities/cash-register.entity';

/**
 * Lista los logs de la caja del actor, ordenados por `created_at DESC`.
 * Endpoint `GET /cash-register/logs?limit=N`.
 *
 * Espejo PlacePos: cuando el actor NO tiene caja, devuelve `[]`.
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class ListCashRegisterLogsAction {
  constructor(
    @InjectRepository(CashRegister)
    private readonly registerRepo: Repository<CashRegister>,
    @InjectRepository(CashRegisterLog)
    private readonly logRepo: Repository<CashRegisterLog>,
  ) {}

  async execute(companyId: number, userId: number, limit?: number): Promise<CashRegisterLog[]> {
    const register = await this.registerRepo.findOne({
      where: { company_id: String(companyId), user_id: String(userId) },
      select: { id: true },
    });

    if (!register) {
      return [];
    }

    return this.logRepo.find({
      where: {
        cash_register_id: register.id,
        company_id: String(companyId),
      },
      order: { created_at: 'DESC' },
      ...(limit !== undefined && limit > 0 ? { take: limit } : {}),
    });
  }
}
