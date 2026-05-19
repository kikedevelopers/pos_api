import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
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

import type { LastSaleResult } from './actions/get-last-sale.action';
import {
  CreateSaleResponseDto,
  toCreateSaleResponseDto,
} from './dto/create-sale-response.dto';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import {
  SaleCreditNoteResponseDto,
  toSaleCreditNoteResponseDto,
} from './dto/sale-credit-note-response.dto';
import { SaleListItemDto } from './dto/sale-list-item.dto';
import { SaleResponseDto, toSaleResponseDto } from './dto/sale-response.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import type { ConsolidatedInvoice } from './internal/consolidate-invoice.helper';
import { SalesService } from './sales.service';

/**
 * Endpoints `/sales`. Espejo de PlacePos `sales.routes.ts`.
 *
 * Roles:
 *   - GETs y `POST /sales`: cualquier autenticado (owner / manager / employee).
 *   - `PUT /sales/:id`, `POST /sales/:id/void`: owner y manager (no employee).
 *
 * Multi-tenancy: el `company_id` se propaga vía `@CurrentCompany()` desde
 * el JWT — nunca del payload o query.
 *
 * Nota Fase 1: los endpoints de pagos y conversión ORDER→SALE viven en
 * `POST /payments` (Fase 4). Aquí solo quedan CRUD + anulación.
 */
@ApiTags('sales')
@ApiBearerAuth('bearer')
@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  // --------------------------------------------------------------------------
  // GET /sales/last
  // --------------------------------------------------------------------------

  @Get('last')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Último ticket de la company. Espejo PlacePos getLastTicketByUser: { id, ticketNumber }.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: '{ id, ticketNumber }' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'No se encontraron tickets' })
  async findLast(@CurrentCompany() companyId: number): Promise<LastSaleResult> {
    const row = await this.salesService.findLast(companyId);
    if (!row) {
      throw new NotFoundException('No se encontraron tickets');
    }
    return row;
  }

  // --------------------------------------------------------------------------
  // GET /sales/:id/consolidated-upto/:noteId
  // --------------------------------------------------------------------------

  @Get(':id/consolidated-upto/:noteId')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Snapshot consolidado del ticket aplicando NC/ND con id <= noteId. Espejo PlacePos.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiParam({ name: 'noteId', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Ticket no encontrado' })
  async findConsolidatedUpto(
    @Param('id', ParseIntPipe) id: number,
    @Param('noteId', ParseIntPipe) noteId: number,
    @CurrentCompany() companyId: number,
  ): Promise<ConsolidatedInvoice> {
    const consolidated = await this.salesService.getConsolidatedUpto(id, noteId, companyId);
    if (!consolidated) {
      throw new NotFoundException('Ticket no encontrado');
    }
    return consolidated;
  }

  // --------------------------------------------------------------------------
  // GET /sales/:id/consolidated
  // --------------------------------------------------------------------------

  @Get(':id/consolidated')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Snapshot consolidado vivo del ticket (todas las NC/ND aplicadas).',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Ticket no encontrado' })
  async findConsolidated(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ConsolidatedInvoice> {
    const consolidated = await this.salesService.getConsolidated(id, companyId);
    if (!consolidated) {
      throw new NotFoundException('Ticket no encontrado');
    }
    return consolidated;
  }

  // --------------------------------------------------------------------------
  // GET /sales/:id/credit-note
  // --------------------------------------------------------------------------

  @Get(':id/credit-note')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Última NC/ND asociada al ticket (más reciente). null si no hay. Espejo PlacePos getCreditNoteByInvoiceId.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: SaleCreditNoteResponseDto })
  async findCreditNote(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<SaleCreditNoteResponseDto | null> {
    const note = await this.salesService.getCreditNote(id, companyId);
    return note ? toSaleCreditNoteResponseDto(note) : null;
  }

  // --------------------------------------------------------------------------
  // GET /sales
  // --------------------------------------------------------------------------

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Listar ventas del día (paridad PlacePos `getTickets`). Acepta ?limit, ' +
      '?ticket_type, ?customer_id, ?date_from, ?date_to, ?show_deleted. ' +
      'Por default filtra ventas de HOY; employees solo ven las suyas. ' +
      'Totales consolidados (V + Σ ND − Σ NC). Shape camelCase exigido por ' +
      'el renderer del POS.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [SaleListItemDto] })
  async findAll(
    @Query() query: ListSalesQueryDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<SaleListItemDto[]> {
    return this.salesService.findAll(companyId, query, currentUser);
  }

  // --------------------------------------------------------------------------
  // GET /sales/:id
  // --------------------------------------------------------------------------

  @Get(':id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Detalle completo de una venta (líneas + pagos + credit).' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: SaleResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta no encontrada' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<SaleResponseDto> {
    const { sale, lines, payments, credit } = await this.salesService.findOne(id, companyId);
    return toSaleResponseDto(sale, lines, payments, credit);
  }

  // --------------------------------------------------------------------------
  // POST /sales
  // --------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Crear una venta (ORDER) con líneas + pagos opcionales. Genera SaleCredit si queda saldo. ' +
      'Retorna shape minimal { success, message, invoice_id, ticket_number } — paridad con el ' +
      '`createOrder` del modo servidor/cliente de PlacePos. Para el aggregate completo usa ' +
      '`GET /sales/:id` con el invoice_id devuelto.',
  })
  @ApiBody({ type: CreateSaleDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CreateSaleResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Cliente archivado, saldo pendiente sin customer, sobrepago, etc.',
  })
  async create(
    @Body() dto: CreateSaleDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CreateSaleResponseDto> {
    const { sale } = await this.salesService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toCreateSaleResponseDto(Number(sale.id), sale.ticket_number);
  }

  // --------------------------------------------------------------------------
  // PUT /sales/:id
  // --------------------------------------------------------------------------

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Editar venta (solo ORDER sin pagos). Si es SALE o tiene pagos → 422.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateSaleDto })
  @ApiResponse({ status: HttpStatus.OK, type: SaleResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Venta no editable (SALE confirmada o tiene pagos)',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSaleDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<SaleResponseDto> {
    const { sale, lines, payments, credit } = await this.salesService.update(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      type: currentUser.type,
    });
    return toSaleResponseDto(sale, lines, payments, credit);
  }

  // --------------------------------------------------------------------------
  // POST /sales/:id/void
  // --------------------------------------------------------------------------

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Anular un ORDER sin pagos. Para SALE confirmada usa CreditNote. Paridad PlacePos: usa POST /void, no DELETE.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Payload `{ voided: true }`.' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Venta SALE o con pagos aplicados',
  })
  async void(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{ voided: true }> {
    await this.salesService.void(id, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      type: currentUser.type,
    });
    return { voided: true };
  }
}
