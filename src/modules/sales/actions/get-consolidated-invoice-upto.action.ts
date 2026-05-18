import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  type ConsolidatedInvoice,
  getConsolidatedInvoiceUpTo,
} from '../internal/consolidate-invoice.helper';

/**
 * Espejo PlacePos `getConsolidatedInvoiceUpTo(invoiceId, noteId)` —
 * snapshot histórico de la factura aplicando notas con `id <= upToNoteId`
 * (INCLUSIVE, paridad confirmada con PlacePos `editOperations.ts`).
 */
@Injectable()
export class GetConsolidatedInvoiceUpToAction {
  constructor(private readonly dataSource: DataSource) {}

  execute(
    saleId: number,
    upToNoteId: number,
    companyId: number,
  ): Promise<ConsolidatedInvoice | null> {
    return getConsolidatedInvoiceUpTo(this.dataSource.manager, companyId, saleId, upToNoteId);
  }
}
