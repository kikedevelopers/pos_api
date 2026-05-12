import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CreateCreditNoteDto } from './dto/create-credit-note.dto';
import { CreditNoteResponseDto, toCreditNoteResponseDto } from './dto/credit-note-response.dto';
import { ListCreditNotesQueryDto } from './dto/list-credit-notes-query.dto';
import { CreditNotesService } from './credit-notes.service';

/**
 * Endpoints `/credit-notes`. Espejo extendido de PlacePos
 * `credit-notes.routes.ts`.
 *
 * PlacePos solo expone `GET /credit-notes/invoice/:invoiceId`. La creación
 * vive como side-effect de `POST /sales/:id/void` (FULL_VOID) y
 * `PUT /sales/:id` (PARTIAL_VOID / ADDITION).
 *
 * Para el cliente CLOUD añadimos endpoints REST tradicionales que el cliente
 * Electron puede llamar para crear notas explícitas. La ruta de PlacePos
 * `GET /credit-notes/invoice/:invoiceId` se preserva para paridad estricta.
 *
 * Roles:
 *   - POST: `owner` y `manager` (no employee — operación contable).
 *   - GETs: cualquier autenticado.
 *   - DELETE: `owner` only (operación administrativa).
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
  // GET /credit-notes
  // --------------------------------------------------------------------------

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Listar notas de la company. Filtros opt-in: ?limit, ?sale_invoice_id, ?customer_id, ?note_type, ?date_from, ?date_to, ?show_deleted.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [CreditNoteResponseDto] })
  async findAll(
    @Query() query: ListCreditNotesQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CreditNoteResponseDto[]> {
    const notes = await this.creditNotesService.findAll(companyId, query);
    // Listado liviano: sin lines/correction_source — paridad PlacePos.
    return notes.map((n) => toCreditNoteResponseDto(n, [], null));
  }

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
    const notes = await this.creditNotesService.findBySale(invoiceId, companyId);
    return notes.map((n) => toCreditNoteResponseDto(n, [], null));
  }

  // --------------------------------------------------------------------------
  // GET /credit-notes/:id
  // --------------------------------------------------------------------------

  @Get(':id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Detalle completo de una nota (líneas + correction_source).' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: CreditNoteResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Nota no encontrada' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<CreditNoteResponseDto> {
    const { note, lines, correction_source } = await this.creditNotesService.findOne(id, companyId);
    return toCreditNoteResponseDto(note, lines, correction_source);
  }

  // --------------------------------------------------------------------------
  // POST /credit-notes
  // --------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Crear nota crédito o débito. En UNA transacción: valida combinación legal, lockea venta + credit, genera folio, reversa pagos (FULL_VOID), ajusta SaleCredit y Customer.balance.',
  })
  @ApiBody({ type: CreateCreditNoteDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CreditNoteResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta o cuenta no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'Combinación ilegal, FULL_VOID duplicado, PARTIAL_VOID excede cantidad, caja cerrada para reverse, etc.',
  })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Folio o FULL_VOID duplicado' })
  async create(
    @Body() dto: CreateCreditNoteDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CreditNoteResponseDto> {
    const { note, lines, correction_source } = await this.creditNotesService.create(
      dto,
      companyId,
      {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      },
    );
    return toCreditNoteResponseDto(note, lines, correction_source);
  }

  // --------------------------------------------------------------------------
  // DELETE /credit-notes/:id (soft)
  // --------------------------------------------------------------------------

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('owner')
  @ApiOperation({
    summary:
      'Anular (soft-delete) una nota recién creada. Solo permitido en las primeras 24h. No revierte los side-effects financieros (debes compensar manualmente).',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Nota no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'La nota tiene más de 24 horas',
  })
  async softDelete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<void> {
    await this.creditNotesService.softDelete(id, companyId, currentUser.user_id);
  }
}
