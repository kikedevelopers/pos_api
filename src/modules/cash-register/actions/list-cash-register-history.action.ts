import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CashRegister } from '../entities/cash-register.entity';

/**
 * Lista TODOS los turnos (abiertos + cerrados) de una company, ordenados
 * por `opened_at DESC`. Endpoint `GET /cash-register/history`.
 *
 * Extensión del API cloud — PlacePos no tiene equivalente porque su modelo
 * de caja no usa turnos. Documentado como divergencia.
 *
 * Soporta `limit` opcional para feeds.
 */
@Injectable()
export class ListCashRegisterHistoryAction {
  constructor(
    @InjectRepository(CashRegister)
    private readonly repo: Repository<CashRegister>,
  ) {}

  async execute(companyId: number, limit?: number): Promise<CashRegister[]> {
    return this.repo.find({
      where: { company_id: String(companyId) },
      order: { opened_at: 'DESC' },
      ...(limit !== undefined && limit > 0 ? { take: limit } : {}),
    });
  }
}
