import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { ListCarrierPaymentsQueryDto } from '../dto/list-carrier-payments-query.dto';
import { CarrierPayment } from '../entities/carrier-payment.entity';

/**
 * Item enriquecido con joins necesarios para el response (carrier_id,
 * purchase_id, purchase_number).
 */
export interface CarrierPaymentListItem {
  payment: CarrierPayment;
  carrier_id: number | null;
  purchase_id: number | null;
  purchase_number: string | null;
}

/**
 * Lista pagos a transportistas (`GET /carrier-payments`).
 *
 * Filtros opcionales:
 *   - `carrier_id`: filtra por el carrier asociado al credit.
 *   - `from`/`to`: rango YYYY-MM-DD sobre `created_at`. `to` inclusivo
 *     hasta el final del día.
 *
 * Sin paginación (espejo PlacePos). Multi-tenant siempre.
 *
 * Implementación: createQueryBuilder con leftJoinAndSelect para evitar N+1
 * sobre la cadena carrier_credit → purchase y carrier_credit → carrier.
 */
@Injectable()
export class ListCarrierPaymentsAction {
  constructor(
    @InjectRepository(CarrierPayment)
    private readonly repo: Repository<CarrierPayment>,
  ) {}

  async execute(
    companyId: number,
    query: ListCarrierPaymentsQueryDto,
  ): Promise<CarrierPaymentListItem[]> {
    const qb = this.repo
      .createQueryBuilder('cp')
      .leftJoin('carrier_credits', 'cc', 'cc.id = cp.carrier_credit_id')
      .leftJoin('purchases', 'p', 'p.id = cc.purchase_id')
      .addSelect('cc.carrier_id', 'cc_carrier_id')
      .addSelect('cc.purchase_id', 'cc_purchase_id')
      .addSelect('p.purchase_number', 'p_purchase_number')
      .where('cp.company_id = :companyId', { companyId: String(companyId) });

    if (query.carrier_id !== undefined) {
      qb.andWhere('cc.carrier_id = :carrierId', { carrierId: String(query.carrier_id) });
    }

    if (query.from) {
      qb.andWhere('cp.created_at >= :from', { from: `${query.from}T00:00:00.000Z` });
    }
    if (query.to) {
      // `to` inclusivo: sumamos 1 día y usamos `<` para no perder pagos del
      // último segundo del día.
      const toDate = new Date(`${query.to}T00:00:00.000Z`);
      toDate.setUTCDate(toDate.getUTCDate() + 1);
      qb.andWhere('cp.created_at < :to', { to: toDate.toISOString() });
    }

    qb.orderBy('cp.created_at', 'DESC');

    const { entities, raw } = await qb.getRawAndEntities<CarrierPayment>();

    return entities.map((payment, idx) => {
      const r = raw[idx] as unknown as Record<string, unknown>;
      return {
        payment,
        carrier_id:
          r.cc_carrier_id !== null && r.cc_carrier_id !== undefined
            ? Number(r.cc_carrier_id)
            : null,
        purchase_id:
          r.cc_purchase_id !== null && r.cc_purchase_id !== undefined
            ? Number(r.cc_purchase_id)
            : null,
        purchase_number: (r.p_purchase_number as string | null | undefined) ?? null,
      };
    });
  }
}
