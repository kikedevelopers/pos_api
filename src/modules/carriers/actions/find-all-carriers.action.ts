import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { Carrier } from '../entities/carrier.entity';
import { CarrierCredit } from '../entities/carrier-credit.entity';

/**
 * Resultado enriquecido con agregados.
 */
export interface CarrierListItem {
  carrier: Carrier;
  pending_balance: number;
  total_purchases: number;
}

/**
 * Lista carriers no archivados de la company, con agregados:
 *   - `pending_balance` = SUM(balance) WHERE balance > 0.
 *   - `total_purchases` = COUNT(distinct purchase_id) en carrier_credits.
 *
 * Calculamos los agregados con una query GROUP BY separada para evitar
 * N+1; luego mergeamos en memoria.
 */
@Injectable()
export class FindAllCarriersAction {
  constructor(
    @InjectRepository(Carrier)
    private readonly carrierRepo: Repository<Carrier>,
    @InjectRepository(CarrierCredit)
    private readonly creditRepo: Repository<CarrierCredit>,
  ) {}

  async execute(companyId: number): Promise<CarrierListItem[]> {
    const carriers = await this.carrierRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { created_at: 'DESC' },
    });

    if (carriers.length === 0) {
      return [];
    }

    // Agregados por carrier (una sola query con GROUP BY).
    const rows = await this.creditRepo
      .createQueryBuilder('c')
      .select('c.carrier_id', 'carrier_id')
      .addSelect('COALESCE(SUM(c.balance), 0)', 'pending_balance')
      .addSelect('COUNT(DISTINCT c.purchase_id)', 'total_purchases')
      .where('c.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('c.carrier_id IN (:...ids)', { ids: carriers.map((c) => c.id) })
      .groupBy('c.carrier_id')
      .getRawMany<{
        carrier_id: string;
        pending_balance: string;
        total_purchases: string;
      }>();

    const byCarrier = new Map<string, { pending_balance: number; total_purchases: number }>();
    for (const r of rows) {
      byCarrier.set(r.carrier_id, {
        pending_balance: preciseNumber(toBig(r.pending_balance), 2),
        total_purchases: Number(r.total_purchases),
      });
    }

    return carriers.map((carrier) => {
      const agg = byCarrier.get(carrier.id) ?? { pending_balance: 0, total_purchases: 0 };
      return {
        carrier,
        pending_balance: agg.pending_balance,
        total_purchases: agg.total_purchases,
      };
    });
  }
}
