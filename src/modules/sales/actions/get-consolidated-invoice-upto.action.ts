import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  type ConsolidatedInvoice,
  getConsolidatedInvoiceUpTo,
  stripConsolidatedInternalFields,
} from '../internal/consolidate-invoice.helper';

/**
 * Espejo PlacePos `getConsolidatedInvoiceUpTo(invoiceId, noteId)` —
 * snapshot histórico de la factura aplicando notas con `id <= upToNoteId`
 * (INCLUSIVE, paridad confirmada con PlacePos `editOperations.ts`).
 */
@Injectable()
export class GetConsolidatedInvoiceUpToAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    saleId: number,
    upToNoteId: number,
    companyId: number,
  ): Promise<ConsolidatedInvoice | null> {
    const invoice = await getConsolidatedInvoiceUpTo(
      this.dataSource.manager,
      companyId,
      saleId,
      upToNoteId,
    );
    // FIX #2: el snapshot interno de empaque NUNCA viaja al cliente.
    return invoice ? stripConsolidatedInternalFields(invoice) : null;
  }
}
