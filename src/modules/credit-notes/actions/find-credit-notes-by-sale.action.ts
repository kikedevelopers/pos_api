import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { findSaleInCompany } from '@/modules/sales/internal/sale-lookups';

import { CreditNote } from '../entities/credit-note.entity';

/**
 * Lista las notas asociadas a una venta. Espejo de
 * `GET /credit-notes/invoice/:invoiceId` de PlacePos.
 *
 * Anti-IDOR: primero valida que la venta pertenezca a la company. Si la
 * venta no existe o pertenece a otra company → 404.
 *
 * Devuelve todas las notas activas en orden cronológico DESC. El service
 * compone con líneas / correction_source si el endpoint lo requiere.
 */
@Injectable()
export class FindCreditNotesBySaleAction {
  constructor(
    @InjectRepository(CreditNote)
    private readonly repo: Repository<CreditNote>,
  ) {}

  async execute(
    saleInvoiceId: number,
    companyId: number,
    options: { includeDeleted?: boolean } = {},
  ): Promise<CreditNote[]> {
    // Valida ownership de la venta (lanza 404 si cross-tenant).
    await findSaleInCompany(this.repo.manager, saleInvoiceId, companyId, {
      requireActive: false,
    });

    const qb = this.repo
      .createQueryBuilder('n')
      .where('n.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('n.sale_invoice_id = :saleId', { saleId: String(saleInvoiceId) })
      .orderBy('n.created_at', 'ASC');

    if (options.includeDeleted !== true) {
      qb.andWhere('n.is_deleted = false');
    }

    return qb.getMany();
  }
}
