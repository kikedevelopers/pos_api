import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { Carrier } from '../entities/carrier.entity';
import { CarrierCredit, CarrierCreditStatus } from '../entities/carrier-credit.entity';
import { findCarrierInCompany } from '../internal/carrier-lookups';

/**
 * Resultado del detalle de carrier.
 */
export interface CarrierDetail {
  carrier: Carrier;
  pending_balance: number;
  total_purchases: number;
  credits: CarrierCredit[];
  recent_payments: unknown[];
}

/**
 * Detalle de un carrier (`GET /carriers/:id`):
 *   - Datos del carrier.
 *   - Créditos pendientes/parciales (balance > 0).
 *   - Últimos 10 pagos.
 *
 * Fase 2A: `recent_payments` se completa cuando exista la entidad
 * `CarrierPayment` y su action de listado. Se devuelve `[]` por ahora.
 */
@Injectable()
export class FindCarrierAction {
  constructor(
    @InjectRepository(Carrier)
    private readonly carrierRepo: Repository<Carrier>,
    @InjectRepository(CarrierCredit)
    private readonly creditRepo: Repository<CarrierCredit>,
  ) {}

  async execute(id: number, companyId: number): Promise<CarrierDetail> {
    const carrier = await findCarrierInCompany(this.carrierRepo.manager, id, companyId);

    const credits = await this.creditRepo.find({
      where: { company_id: String(companyId), carrier_id: String(id) },
      order: { created_at: 'DESC' },
    });

    const pendingBalance = credits
      .filter((c) => c.status !== CarrierCreditStatus.PAID)
      .reduce((acc, c) => acc.plus(toBig(c.balance)), toBig(0));

    return {
      carrier,
      pending_balance: preciseNumber(pendingBalance, 2),
      total_purchases: credits.length,
      credits,
      recent_payments: [],
    };
  }
}
