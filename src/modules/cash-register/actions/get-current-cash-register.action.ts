import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CashRegister, CashRegisterStatus } from '../entities/cash-register.entity';

/**
 * Devuelve el turno actualmente abierto para una company, o `null` si no
 * hay ninguno. Endpoint `GET /cash-register/current`.
 *
 * Read puro — no requiere transacción. El UNIQUE parcial
 * `idx_cash_registers_one_open_per_company` garantiza que el `findOne`
 * sea determinista.
 */
@Injectable()
export class GetCurrentCashRegisterAction {
  constructor(
    @InjectRepository(CashRegister)
    private readonly repo: Repository<CashRegister>,
  ) {}

  async execute(companyId: number): Promise<CashRegister | null> {
    return this.repo.findOne({
      where: { company_id: String(companyId), status: CashRegisterStatus.OPEN },
    });
  }
}
