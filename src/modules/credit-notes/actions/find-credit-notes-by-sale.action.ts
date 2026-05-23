import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { findSaleInCompany } from '@/modules/sales/internal/sale-lookups';

import { CorrectionSource } from '../entities/correction-source.entity';
import { CreditNoteLine } from '../entities/credit-note-line.entity';
import { CreditNote } from '../entities/credit-note.entity';

/**
 * Resultado del find: nota + lines + correction_source asociado.
 * El controller los serializa con `toCreditNoteResponseDto`.
 */
export interface CreditNoteAggregate {
  note: CreditNote;
  lines: CreditNoteLine[];
  correctionSource: CorrectionSource | null;
}

/**
 * Lista las notas asociadas a una venta junto con sus lines y
 * `correction_source` agregado. Espejo de `GET /credit-notes/invoice/:invoiceId`
 * de PlacePos.
 *
 * Anti-IDOR: primero valida que la venta pertenezca a la company. Si la
 * venta no existe o pertenece a otra company → 404.
 *
 * Performance: evita N+1 cargando lines y correction_sources en dos queries
 * batch (`WHERE credit_note_id IN (...)`) en lugar de una por nota.
 */
@Injectable()
export class FindCreditNotesBySaleAction {
  constructor(
    @InjectRepository(CreditNote)
    private readonly notesRepo: Repository<CreditNote>,
    @InjectRepository(CreditNoteLine)
    private readonly linesRepo: Repository<CreditNoteLine>,
    @InjectRepository(CorrectionSource)
    private readonly correctionsRepo: Repository<CorrectionSource>,
  ) {}

  async execute(
    saleInvoiceId: number,
    companyId: number,
    options: { includeDeleted?: boolean } = {},
  ): Promise<CreditNoteAggregate[]> {
    // Valida ownership de la venta (lanza 404 si cross-tenant).
    await findSaleInCompany(this.notesRepo.manager, saleInvoiceId, companyId, {
      requireActive: false,
    });

    const qb = this.notesRepo
      .createQueryBuilder('n')
      .where('n.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('n.sale_invoice_id = :saleId', { saleId: String(saleInvoiceId) })
      .orderBy('n.created_at', 'ASC');

    if (options.includeDeleted !== true) {
      qb.andWhere('n.is_deleted = false');
    }

    const notes = await qb.getMany();
    if (notes.length === 0) {
      return [];
    }

    const noteIds = notes.map((n) => n.id);

    // Batch fetch: una sola query por relación (no N+1).
    const [lines, corrections] = await Promise.all([
      this.linesRepo
        .createQueryBuilder('l')
        .where('l.company_id = :companyId', { companyId: String(companyId) })
        .andWhere('l.credit_note_id IN (:...noteIds)', { noteIds })
        .orderBy('l.credit_note_id', 'ASC')
        .addOrderBy('l.id', 'ASC')
        .getMany(),
      this.correctionsRepo
        .createQueryBuilder('cs')
        .where('cs.company_id = :companyId', { companyId: String(companyId) })
        .andWhere('cs.credit_note_id IN (:...noteIds)', { noteIds })
        .getMany(),
    ]);

    const linesByNote = new Map<string, CreditNoteLine[]>();
    for (const line of lines) {
      const key = line.credit_note_id;
      const arr = linesByNote.get(key);
      if (arr) {
        arr.push(line);
      } else {
        linesByNote.set(key, [line]);
      }
    }

    const correctionByNote = new Map<string, CorrectionSource>();
    for (const cs of corrections) {
      correctionByNote.set(cs.credit_note_id, cs);
    }

    return notes.map((note) => ({
      note,
      lines: linesByNote.get(note.id) ?? [],
      correctionSource: correctionByNote.get(note.id) ?? null,
    }));
  }
}
