import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import type { ListDeliveriesQueryDto } from '../dto/list-deliveries-query.dto';
import { Delivery } from '../entities/delivery.entity';

/**
 * Lista los domicilios de una company aplicando filtros opcionales:
 *   - `company_id` (query) → filtra por DOMICILIARIO (`delivery_company_id`).
 *   - `payment_method`.
 *   - `date_from`/`date_to` (rango sobre `created_at`).
 *   - `search` (ILIKE sobre recipient_name, destination_address, ticket).
 *   - `include_archived` (default false).
 *
 * **Multi-tenancy**: filtro `company_id` (tenant) SIEMPRE aplicado vía
 * QueryBuilder. El `company_id` del query NUNCA se confunde con el tenant.
 *
 * **Performance**: el índice `(company_id, created_at DESC) WHERE is_archived
 * = false` cubre el feed por defecto; `(company_id, delivery_company_id)`
 * cubre el filtro por domiciliario.
 */
@Injectable()
export class FindAllDeliveriesAction {
  constructor(
    @InjectRepository(Delivery)
    private readonly repo: Repository<Delivery>,
  ) {}

  execute(tenantCompanyId: number, query: ListDeliveriesQueryDto): Promise<Delivery[]> {
    const includeArchived = query.include_archived === 'true';

    const qb = this.repo
      .createQueryBuilder('d')
      .where('d.company_id = :tenantCompanyId', { tenantCompanyId: String(tenantCompanyId) });

    if (!includeArchived) {
      qb.andWhere('d.is_archived = :archived', { archived: false });
    }

    if (query.company_id !== undefined) {
      qb.andWhere('d.delivery_company_id = :deliveryCompanyId', {
        deliveryCompanyId: String(query.company_id),
      });
    }

    if (query.payment_method) {
      qb.andWhere('d.payment_method = :paymentMethod', { paymentMethod: query.payment_method });
    }

    if (query.date_from) {
      qb.andWhere('d.created_at >= :dateFrom', {
        dateFrom: new Date(`${query.date_from}T00:00:00.000Z`),
      });
    }
    if (query.date_to) {
      qb.andWhere('d.created_at <= :dateTo', {
        dateTo: new Date(`${query.date_to}T23:59:59.999Z`),
      });
    }

    if (query.search) {
      const term = `%${query.search}%`;
      qb.andWhere(
        new Brackets((w) => {
          w.where('d.recipient_name ILIKE :term', { term })
            .orWhere('d.destination_address ILIKE :term', { term })
            .orWhere('d.ticket_number ILIKE :term', { term })
            .orWhere('d.delivery_company_name ILIKE :term', { term });
        }),
      );
    }

    return qb.orderBy('d.created_at', 'DESC').addOrderBy('d.id', 'DESC').getMany();
  }
}
