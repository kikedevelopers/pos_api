import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { Carrier } from '../entities/carrier.entity';
import { CarrierCredit } from '../entities/carrier-credit.entity';

/**
 * Shape de respuesta de `GET /carriers/analytics`.
 */
export interface CarriersAnalyticsResult {
  total_active: number;
  total_pending_debt: number;
  total_paid_today: number;
}

/**
 * Calcula KPIs de transportistas para el dashboard.
 *
 *   - `total_active`: COUNT carriers no archivados.
 *   - `total_pending_debt`: SUM(carrier_credits.balance) WHERE balance > 0.
 *   - `total_paid_today`: SUM(carrier_payments.amount) WHERE created_at hoy.
 *
 * `total_paid_today` se consulta directamente sobre la tabla
 * `carrier_payments` con `manager.query` para evitar import circular (la
 * entidad vive en otro módulo `carrier-payments`). Si la tabla aún no
 * existe (orden de migraciones), devolvemos 0.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class GetCarriersAnalyticsAction {
  constructor(
    @InjectRepository(Carrier)
    private readonly carrierRepo: Repository<Carrier>,
    @InjectRepository(CarrierCredit)
    private readonly creditRepo: Repository<CarrierCredit>,
  ) {}

  async execute(companyId: number): Promise<CarriersAnalyticsResult> {
    const totalActive = await this.carrierRepo.count({
      where: { company_id: String(companyId), is_archived: false },
    });

    const debtRow = await this.creditRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.balance), 0)', 'total')
      .where('c.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('c.balance > 0')
      .getRawOne<{ total: string }>();

    const totalPendingDebt = preciseNumber(toBig(debtRow?.total ?? 0), 2);

    // Pagos del día: query directa sobre `carrier_payments` (módulo separado).
    // Si la tabla aún no existe — fallback a 0 sin reventar.
    let totalPaidToday = 0;
    try {
      const paidRow = await this.carrierRepo.manager.query<Array<{ total: string }>>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM carrier_payments
         WHERE company_id = $1
           AND created_at >= date_trunc('day', now())
           AND created_at <  date_trunc('day', now()) + interval '1 day'`,
        [companyId],
      );
      totalPaidToday = preciseNumber(toBig(paidRow[0]?.total ?? 0), 2);
    } catch {
      totalPaidToday = 0;
    }

    return {
      total_active: totalActive,
      total_pending_debt: totalPendingDebt,
      total_paid_today: totalPaidToday,
    };
  }
}
