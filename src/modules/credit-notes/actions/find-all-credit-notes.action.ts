import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { ListCreditNotesQueryDto } from '../dto/list-credit-notes-query.dto';
import { CreditNote } from '../entities/credit-note.entity';

/**
 * Lista notas de una company con filtros del DTO. Espejo PlacePos.
 *
 * Multi-tenancy: filtro estricto por `company_id`.
 *
 * Índices que cubren los planes:
 *   - `idx_credit_notes_company_active_created` (feed cronológico).
 *   - `idx_credit_notes_company_sale_invoice` (filtro por venta).
 *   - `idx_credit_notes_company_customer_created` (filtro por cliente).
 */
@Injectable()
export class FindAllCreditNotesAction {
  constructor(
    @InjectRepository(CreditNote)
    private readonly repo: Repository<CreditNote>,
  ) {}

  async execute(companyId: number, query: ListCreditNotesQueryDto): Promise<CreditNote[]> {
    const qb = this.repo
      .createQueryBuilder('n')
      .where('n.company_id = :companyId', { companyId: String(companyId) })
      .orderBy('n.created_at', 'DESC');

    if (query.show_deleted !== true) {
      qb.andWhere('n.is_deleted = false');
    }
    if (typeof query.sale_invoice_id === 'number') {
      qb.andWhere('n.sale_invoice_id = :saleId', { saleId: String(query.sale_invoice_id) });
    }
    if (typeof query.customer_id === 'number') {
      qb.andWhere('n.customer_id = :customerId', { customerId: String(query.customer_id) });
    }
    if (query.note_type) {
      qb.andWhere('n.note_type = :noteType', { noteType: query.note_type });
    }
    if (query.date_from) {
      qb.andWhere('n.created_at >= :dateFrom', { dateFrom: query.date_from });
    }
    if (query.date_to) {
      qb.andWhere(`n.created_at < (:dateTo::date + INTERVAL '1 day')`, { dateTo: query.date_to });
    }
    if (typeof query.limit === 'number' && query.limit > 0) {
      qb.limit(query.limit);
    }

    return qb.getMany();
  }
}
