import { Injectable } from '@nestjs/common';

import { FindCreditNotesBySaleAction } from './actions/find-credit-notes-by-sale.action';
import type { CreditNote } from './entities/credit-note.entity';

/**
 * Facade del módulo `credit-notes`. ZERO lógica — solo delega.
 *
 * Paridad PlacePos: el único endpoint REST es `GET /credit-notes/invoice/:invoiceId`.
 * La creación de NC/ND vive como side-effect de los flujos de venta (voidSale,
 * editSale) y procesamiento de pagos. Esos actions construyen e insertan las
 * notas directamente dentro de su propia transacción — no hay una "factory"
 * compartida de creación que cruce módulos.
 */
@Injectable()
export class CreditNotesService {
  constructor(private readonly findCreditNotesBySaleAction: FindCreditNotesBySaleAction) {}

  findBySale(saleInvoiceId: number, companyId: number): Promise<CreditNote[]> {
    return this.findCreditNotesBySaleAction.execute(saleInvoiceId, companyId);
  }
}
