import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CashRegisterLog } from '../entities/cash-register-log.entity';
import { CashRegister, CashRegisterStatus } from '../entities/cash-register.entity';

/**
 * Lista los logs del turno actualmente abierto, ordenados por
 * `created_at DESC`. Endpoint `GET /cash-register/logs?limit=N`.
 *
 * Espejo de PlacePos: cuando no hay turno abierto, devuelve `[]`.
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

  async execute(companyId: number, limit?: number): Promise<CashRegisterLog[]> {
    const register = await this.registerRepo.findOne({
      where: { company_id: String(companyId), status: CashRegisterStatus.OPEN },
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
