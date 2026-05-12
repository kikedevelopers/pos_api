import { Injectable } from '@nestjs/common';

import {
  CreateCreditNoteAction,
  type CreditNoteCreator,
} from './actions/create-credit-note.action';
import { FindAllCreditNotesAction } from './actions/find-all-credit-notes.action';
import { FindCreditNoteAction, type CreditNoteAggregate } from './actions/find-credit-note.action';
import { FindCreditNotesBySaleAction } from './actions/find-credit-notes-by-sale.action';
import { SoftDeleteCreditNoteAction } from './actions/soft-delete-credit-note.action';
import type { CreateCreditNoteDto } from './dto/create-credit-note.dto';
import type { ListCreditNotesQueryDto } from './dto/list-credit-notes-query.dto';
import type { CreditNote } from './entities/credit-note.entity';

export type { CreditNoteCreator } from './actions/create-credit-note.action';
export type { CreditNoteAggregate } from './actions/find-credit-note.action';

/**
 * Facade del módulo `credit-notes`. ZERO lógica — solo delega.
 */
@Injectable()
export class CreditNotesService {
  constructor(
    private readonly findAllCreditNotesAction: FindAllCreditNotesAction,
    private readonly findCreditNoteAction: FindCreditNoteAction,
    private readonly findCreditNotesBySaleAction: FindCreditNotesBySaleAction,
    private readonly createCreditNoteAction: CreateCreditNoteAction,
    private readonly softDeleteCreditNoteAction: SoftDeleteCreditNoteAction,
  ) {}

  findAll(companyId: number, query: ListCreditNotesQueryDto): Promise<CreditNote[]> {
    return this.findAllCreditNotesAction.execute(companyId, query);
  }

  findOne(id: number, companyId: number): Promise<CreditNoteAggregate> {
    return this.findCreditNoteAction.execute(id, companyId);
  }

  findBySale(saleInvoiceId: number, companyId: number): Promise<CreditNote[]> {
    return this.findCreditNotesBySaleAction.execute(saleInvoiceId, companyId);
  }

  create(
    dto: CreateCreditNoteDto,
    companyId: number,
    createdBy: CreditNoteCreator,
  ): Promise<CreditNoteAggregate> {
    return this.createCreditNoteAction.execute(dto, companyId, createdBy);
  }

  softDelete(id: number, companyId: number, actorId: number): Promise<void> {
    return this.softDeleteCreditNoteAction.execute(id, companyId, actorId);
  }
}
