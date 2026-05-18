import type { EntityManager } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';
import {
  CreditNote,
  NoteType,
  OperationType,
} from '@/modules/credit-notes/entities/credit-note.entity';
import type { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import type { LineDifference } from './compute-line-delta';

/**
 * Actor que ejecuta la edición. Se persiste como `created_by` / `created_by_id`
 * en la NC y/o ND.
 */
export interface EditNoteActor {
  id: number;
  fullName: string;
}

/**
 * Resultado de emitir las notas. Cualquiera puede ser `null` si la edición
 * no requirió esa nota (ej. solo añadió → solo ND).
 */
export interface EditNotesResult {
  creditNoteId: number | null;
  creditNoteNumber: string | null;
  debitNoteId: number | null;
  debitNoteNumber: string | null;
}

/**
 * Crea la NC `PARTIAL_VOID` (si hubo `removedOrReduced`) y la ND `ADDITION`
 * (si hubo `addedOrIncreased`) dentro de la transacción del caller. Espejo
 * de `processCreditPart` + `processDebitPart` de PlacePos `editOperations.ts`.
 *
 * --------------------------------------------------------------------------
 * Operación contable
 * --------------------------------------------------------------------------
 *
 *   - PlacePos clasifica una edición como FULL_VOID cuando TODAS las líneas
 *     se removieron y no hay líneas añadidas. En este API, sin embargo,
 *     `voidSale` es el único camino oficial para FULL_VOID (paridad con el
 *     endpoint `POST /sales/:id/void`). Aquí siempre emitimos `PARTIAL_VOID`
 *     para la parte CREDIT — si el operador pretendía anular completa, debe
 *     usar el endpoint de void. PlacePos local tolera ambos caminos; nuestro
 *     contrato cloud los separa para que el rol de `manager` (que sí puede
 *     editar) no termine generando FULL_VOID a través de `PUT /sales/:id`.
 *
 *   - La ND siempre es `ADDITION` (paridad PlacePos).
 *
 *   - El UPDATE de `SaleInvoice` (totales, cliente) se hace en el caller
 *     porque depende del estado consolidado completo (NC + ND + líneas
 *     base) — este helper se concentra solo en la emisión de las notas.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy + side effects de caja
 * --------------------------------------------------------------------------
 *
 *   Todas las INSERT incluyen `company_id`. El registro de movimientos de
 *   caja / banco / wallet vinculados al correction_source NO se hace aquí —
 *   sigue siendo responsabilidad del caller (idéntico a PlacePos:
 *   `processCreditPart` llama a `registerCreditNote*` y este helper solo
 *   reproduce la parte de NC/ND).
 */
export async function generateEditNotes(
  manager: EntityManager,
  incrementTicketNumberAction: IncrementTicketNumberAction,
  params: {
    companyId: number;
    saleInvoiceId: number;
    customerId: number | null;
    removedOrReduced: LineDifference[];
    addedOrIncreased: LineDifference[];
    actor: EditNoteActor;
  },
): Promise<EditNotesResult> {
  const result: EditNotesResult = {
    creditNoteId: null,
    creditNoteNumber: null,
    debitNoteId: null,
    debitNoteNumber: null,
  };

  if (params.removedOrReduced.length > 0) {
    const cnTicket = await incrementTicketNumberAction.execute(
      manager,
      params.companyId,
      TicketSettingType.CREDIT_NOTE,
    );
    const subtotal = params.removedOrReduced.reduce(
      (acc, l) => acc.plus(toBig(l.subtotal)),
      toBig(0),
    );
    const taxTotal = params.removedOrReduced.reduce(
      (acc, l) => acc.plus(toBig(l.iva_amount)),
      toBig(0),
    );
    const total = params.removedOrReduced.reduce((acc, l) => acc.plus(toBig(l.total)), toBig(0));
    const cn = manager.create(CreditNote, {
      company_id: String(params.companyId),
      sale_invoice_id: String(params.saleInvoiceId),
      customer_id: params.customerId === null ? null : String(params.customerId),
      note_number: cnTicket.formatted,
      note_type: NoteType.CREDIT,
      operation_type: OperationType.PARTIAL_VOID,
      subtotal: Number(subtotal.toFixed(2)),
      tax_total: Number(taxTotal.toFixed(2)),
      total: Number(total.toFixed(2)),
      reason: 'Edición de venta — productos removidos o reducidos',
      created_by: params.actor.fullName,
      created_by_id: String(params.actor.id),
      is_deleted: false,
    });
    const savedCn = await manager.save(CreditNote, cn);

    const cnLines = params.removedOrReduced.map((l) => ({
      company_id: String(params.companyId),
      credit_note_id: savedCn.id,
      original_line_id: null,
      product_id: String(l.product_id),
      packaging_id: l.packaging_id === null ? null : String(l.packaging_id),
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      unit_cost: l.unit_cost,
      subtotal: l.subtotal,
      iva_percentage: l.iva_percentage,
      iva_amount: l.iva_amount,
      total: l.total,
    }));
    await manager.insert(CreditNoteLine, cnLines);

    result.creditNoteId = Number(savedCn.id);
    result.creditNoteNumber = savedCn.note_number;
  }

  if (params.addedOrIncreased.length > 0) {
    const dnTicket = await incrementTicketNumberAction.execute(
      manager,
      params.companyId,
      TicketSettingType.DEBIT_NOTE,
    );
    const subtotal = params.addedOrIncreased.reduce(
      (acc, l) => acc.plus(toBig(l.subtotal)),
      toBig(0),
    );
    const taxTotal = params.addedOrIncreased.reduce(
      (acc, l) => acc.plus(toBig(l.iva_amount)),
      toBig(0),
    );
    const total = params.addedOrIncreased.reduce((acc, l) => acc.plus(toBig(l.total)), toBig(0));
    const dn = manager.create(CreditNote, {
      company_id: String(params.companyId),
      sale_invoice_id: String(params.saleInvoiceId),
      customer_id: params.customerId === null ? null : String(params.customerId),
      note_number: dnTicket.formatted,
      note_type: NoteType.DEBIT,
      operation_type: OperationType.ADDITION,
      subtotal: Number(subtotal.toFixed(2)),
      tax_total: Number(taxTotal.toFixed(2)),
      total: Number(total.toFixed(2)),
      reason: 'Edición de venta — productos añadidos o incrementados',
      created_by: params.actor.fullName,
      created_by_id: String(params.actor.id),
      is_deleted: false,
    });
    const savedDn = await manager.save(CreditNote, dn);

    const dnLines = params.addedOrIncreased.map((l) => ({
      company_id: String(params.companyId),
      credit_note_id: savedDn.id,
      original_line_id: null,
      product_id: String(l.product_id),
      packaging_id: l.packaging_id === null ? null : String(l.packaging_id),
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      unit_cost: l.unit_cost,
      subtotal: l.subtotal,
      iva_percentage: l.iva_percentage,
      iva_amount: l.iva_amount,
      total: l.total,
    }));
    await manager.insert(CreditNoteLine, dnLines);

    result.debitNoteId = Number(savedDn.id);
    result.debitNoteNumber = savedDn.note_number;
  }

  return result;
}
