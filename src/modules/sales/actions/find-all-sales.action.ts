import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { ListSalesQueryDto } from '../dto/list-sales-query.dto';
import { SaleInvoice } from '../entities/sale-invoice.entity';

/**
 * Lista ventas de una company aplicando los filtros del DTO. Espejo
 * `GET /sales` de PlacePos (`?limit=N` opcional).
 *
 * Multi-tenancy: filtro estricto por `company_id`.
 *
 * Read puro — no requiere transacción. Cubre el feed cronológico DESC.
 * El índice `idx_sale_invoices_company_active_created` cubre el filtro
 * + orden. Si llega `customer_id` se cambia al índice
 * `idx_sale_invoices_company_customer_created`.
 */
@Injectable()
export class FindAllSalesAction {
  constructor(
    @InjectRepository(SaleInvoice)
    private readonly repo: Repository<SaleInvoice>,
  ) {}

  async execute(companyId: number, query: ListSalesQueryDto): Promise<SaleInvoice[]> {
    const qb = this.repo
      .createQueryBuilder('s')
      .where('s.company_id = :companyId', { companyId: String(companyId) })
      .orderBy('s.created_at', 'DESC');

    if (query.show_deleted !== true) {
      qb.andWhere('s.is_deleted = false');
    }
    if (query.ticket_type) {
      qb.andWhere('s.ticket_type = :ticketType', { ticketType: query.ticket_type });
    }
    if (typeof query.customer_id === 'number') {
      qb.andWhere('s.customer_id = :customerId', { customerId: String(query.customer_id) });
    }
    if (query.date_from) {
      qb.andWhere('s.created_at >= :dateFrom', { dateFrom: query.date_from });
    }
    if (query.date_to) {
      // Incluye todo el día indicado (00:00:00 del día siguiente, exclusivo).
      qb.andWhere(`s.created_at < (:dateTo::date + INTERVAL '1 day')`, { dateTo: query.date_to });
    }
    if (typeof query.limit === 'number' && query.limit > 0) {
      qb.limit(query.limit);
    }

    return qb.getMany();
  }
}
