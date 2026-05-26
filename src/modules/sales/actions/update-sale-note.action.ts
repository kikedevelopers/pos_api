import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SaleInvoice } from '../entities/sale-invoice.entity';
import { findSaleInCompany } from '../internal/sale-lookups';
import { translateSaleConstraintError } from '../internal/constraint-errors';

/**
 * Resultado de actualizar la nota a NIVEL TICKET. Shape minimal que el
 * controller envuelve vía `ResponseWrapperInterceptor`.
 */
export interface UpdateSaleNoteActionResult {
  id: number;
  notes: string | null;
}

/**
 * Actualiza SOLO `sale_invoices.notes` de una venta. Espejo del endpoint de
 * nota por ticket del servidor Express offline de PlacePos.
 *
 * Multi-tenant: la venta se localiza por `id` + `company_id` del JWT. Si no
 * existe (o pertenece a otra company) → `NotFoundException` con el patrón de
 * errores del proyecto (`findSaleInCompany`).
 *
 * Idempotente: reenviar el mismo `notes` deja el mismo estado. Se normaliza
 * `trim()` + cadena vacía → `null` (paridad PlacePos: una nota en blanco
 * equivale a "sin nota").
 *
 * Transacción simple (`READ COMMITTED` por default): un único UPDATE escalar
 * sobre la cabecera, sin lecturas dependientes ni movimientos financieros.
 */
@Injectable()
export class UpdateSaleNoteAction {
  private readonly logger = new Logger(UpdateSaleNoteAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(params: {
    invoiceId: number;
    companyId: number;
    notes: string | null;
  }): Promise<UpdateSaleNoteActionResult> {
    const { invoiceId, companyId, notes } = params;
    const normalized = typeof notes === 'string' ? notes.trim() || null : null;

    return this.dataSource.transaction<UpdateSaleNoteActionResult>(async (manager) => {
      // Localiza la venta dentro de la company (lanza NotFoundException si no
      // existe). No exige `is_deleted = false`: la nota puede editarse aunque
      // la venta esté anulada — paridad PlacePos.
      const sale = await findSaleInCompany(manager, invoiceId, companyId, {
        requireActive: false,
      });

      try {
        await manager.update(
          SaleInvoice,
          { id: sale.id, company_id: String(companyId) },
          { notes: normalized },
        );
      } catch (error) {
        translateSaleConstraintError(error);
        throw error;
      }

      this.logger.log({
        event: 'sale.note.updated',
        companyId,
        saleId: Number(sale.id),
        hasNote: normalized !== null,
      });

      return { id: Number(sale.id), notes: normalized };
    });
  }
}
