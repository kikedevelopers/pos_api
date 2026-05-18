import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreditNote } from '@/modules/credit-notes/entities/credit-note.entity';

/**
 * Espejo PlacePos `getCreditNoteByInvoiceId` — devuelve la NC/ND MÁS
 * RECIENTE de la venta (por created_at DESC), sin líneas. NULL si no hay.
 *
 * Paridad PlacePos: no se filtra `is_deleted`.
 */
@Injectable()
export class GetSaleCreditNoteAction {
  constructor(
    @InjectRepository(CreditNote)
    private readonly creditNotesRepo: Repository<CreditNote>,
  ) {}

  async execute(saleId: number, companyId: number): Promise<CreditNote | null> {
    return this.creditNotesRepo.findOne({
      where: {
        sale_invoice_id: String(saleId),
        company_id: String(companyId),
      },
      order: { created_at: 'DESC' },
    });
  }
}
