import { Controller, Get, HttpStatus, Param, ParseIntPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { CreditNoteResponseDto, toCreditNoteResponseDto } from './dto/credit-note-response.dto';
import { CreditNotesService } from './credit-notes.service';

/**
 * Endpoints `/credit-notes` — paridad estricta PlacePos.
 *
 * PlacePos solo expone `GET /credit-notes/invoice/:invoiceId`. La creación
 * de notas vive como side-effect de los endpoints de venta/anulación (no como
 * recurso REST independiente). Por eso este controller queda con UN solo
 * endpoint.
 *
 * Roles: cualquier autenticado (read-only). La creación real se hace dentro
 * de las acciones que orquestan ventas/anulaciones en Fase 4+.
 *
 * Multi-tenancy: el `company_id` se propaga vía `@CurrentCompany()` desde
 * el JWT — nunca del payload o query.
 */
@ApiTags('credit-notes')
@ApiBearerAuth('bearer')
@Controller('credit-notes')
export class CreditNotesController {
  constructor(private readonly creditNotesService: CreditNotesService) {}

  // --------------------------------------------------------------------------
  // GET /credit-notes/invoice/:invoiceId
  // --------------------------------------------------------------------------

  @Get('invoice/:invoiceId')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Listar notas asociadas a una venta. Espejo de PlacePos GET /credit-notes/invoice/:invoiceId.',
  })
  @ApiParam({ name: 'invoiceId', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: [CreditNoteResponseDto] })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta no encontrada' })
  async findBySale(
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
    @CurrentCompany() companyId: number,
  ): Promise<CreditNoteResponseDto[]> {
    const aggregates = await this.creditNotesService.findBySale(invoiceId, companyId);
    return aggregates.map((agg) =>
      toCreditNoteResponseDto(agg.note, agg.lines, agg.correctionSource),
    );
  }
}
