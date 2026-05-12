import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { CorrectionSource } from '../entities/correction-source.entity';
import { CreditNoteLine } from '../entities/credit-note-line.entity';
import { CreditNote } from '../entities/credit-note.entity';
import {
  findNoteCorrectionSource,
  findNoteInCompany,
  findNoteLines,
} from '../internal/credit-note-lookups';

/**
 * Agregado completo de una nota (cabecera + líneas + correction_source).
 * Espejo PlacePos.
 */
export interface CreditNoteAggregate {
  note: CreditNote;
  lines: CreditNoteLine[];
  correction_source: CorrectionSource | null;
}

/**
 * Lee el detalle completo de una nota por id, dentro de la company.
 *
 * Anti-IDOR: el `findNoteInCompany` exige `company_id = $current`. Si el id
 * existe en otra company → 404 indistinguible.
 *
 * Sin N+1: 3 round-trips dedicados (header + lines + correction_source).
 */
@Injectable()
export class FindCreditNoteAction {
  constructor(
    @InjectRepository(CreditNote)
    private readonly repo: Repository<CreditNote>,
  ) {}

  async execute(
    id: number,
    companyId: number,
    options: { requireActive?: boolean } = {},
  ): Promise<CreditNoteAggregate> {
    const manager = this.repo.manager;
    const note = await findNoteInCompany(manager, id, companyId, {
      requireActive: options.requireActive ?? true,
    });
    const lines = await findNoteLines(manager, Number(note.id), companyId);
    const correctionSource = await findNoteCorrectionSource(manager, Number(note.id), companyId);
    return { note, lines, correction_source: correctionSource };
  }
}
