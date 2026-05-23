import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CashRegisterLog } from '../entities/cash-register-log.entity';
import { CashRegister } from '../entities/cash-register.entity';

/**
 * Lista los logs de la caja del actor, ordenados por `id DESC`.
 * Endpoint `GET /cash-register/logs?limit=N`.
 *
 * Espejo PlacePos: cuando el actor NO tiene caja, devuelve `[]`.
 *
 * Sobre el orden:
 *   placepos ordena por `id DESC` — los 3 logs que una venta CASH inserta
 *   en la misma transacción (CASH_RECEIVED → CASH_PAYMENT → CASH_CHANGE)
 *   reciben ids consecutivos y `id DESC` garantiza el orden visual esperado:
 *   primero el concepto que afecta balance (PAYMENT), luego los REF
 *   (RECEIVED y CHANGE).
 *
 *   Ordenar por `created_at DESC` es ambiguo porque los 3 inserts comparten
 *   timestamp prácticamente al microsegundo dentro de la transacción y
 *   PostgreSQL los devuelve en orden arbitrario — terminaba mostrando el
 *   REF antes del concepto original.
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
      order: { id: 'DESC' },
      ...(limit !== undefined && limit > 0 ? { take: limit } : {}),
    });
  }
}
