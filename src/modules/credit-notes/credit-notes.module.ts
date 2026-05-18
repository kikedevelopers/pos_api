import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FindCreditNotesBySaleAction } from './actions/find-credit-notes-by-sale.action';
import { CreditNotesController } from './credit-notes.controller';
import { CreditNotesService } from './credit-notes.service';
import { CorrectionSource } from './entities/correction-source.entity';
import { CreditNoteLine } from './entities/credit-note-line.entity';
import { CreditNote } from './entities/credit-note.entity';

/**
 * Módulo `credit-notes` (paridad PlacePos).
 *
 * Solo expone `GET /credit-notes/invoice/:invoiceId`. La creación real de
 * NC/ND vive en `SalesModule` (void-sale, edit-sale) que importa este módulo
 * para reusar las entidades (CreditNote, CreditNoteLine, CorrectionSource).
 *
 * `TypeOrmModule.forFeature` queda exportado para que SalesModule consuma
 * los repositorios sin re-registrarlos.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CreditNote, CreditNoteLine, CorrectionSource])],
  controllers: [CreditNotesController],
  providers: [CreditNotesService, FindCreditNotesBySaleAction],
  exports: [CreditNotesService, TypeOrmModule],
})
export class CreditNotesModule {}
