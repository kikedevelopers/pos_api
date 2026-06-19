import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
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
import { RealtimeGateway } from '@/modules/realtime/realtime.gateway';

import type { CollectSaleBalanceResult } from './actions/collect-sale-balance.action';
import type { DeleteSalePaymentResult } from './actions/delete-sale-payment.action';
import type { LastSaleResult } from './actions/get-last-sale.action';
import { CollectSaleBalanceDto } from './dto/collect-sale-balance.dto';
import { CreateSaleResponseDto, toCreateSaleResponseDto } from './dto/create-sale-response.dto';
import { CreateSaleDto } from './dto/create-sale.dto';
import { DeleteSalePaymentDto } from './dto/delete-sale-payment.dto';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import {
  SaleCreditNoteResponseDto,
  toSaleCreditNoteResponseDto,
} from './dto/sale-credit-note-response.dto';
import { SaleListItemDto } from './dto/sale-list-item.dto';
import { SaleResponseDto, toSaleResponseDto } from './dto/sale-response.dto';
import { UpdateSaleNoteDto } from './dto/update-sale-note.dto';
import type { UpdateSaleNoteActionResult } from './actions/update-sale-note.action';
import {
  UpdateSaleResponseDto,
  VoidSaleResponseDto,
  toUpdateSaleResponseDto,
  toVoidSaleResponseDto,
} from './dto/update-sale-response.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { VoidSaleDto } from './dto/void-sale.dto';
import type { ConsolidatedInvoice } from './internal/consolidate-invoice.helper';
import { SalesService } from './sales.service';

/**
 * Endpoints `/sales`. Espejo de PlacePos `sales.routes.ts`.
 *
 * Roles:
 *   - Todos los endpoints (GETs, `POST /sales`, `PUT /sales/:id`,
 *     `POST /sales/:id/void`): cualquier autenticado
 *     (owner / manager / employee) — paridad con PlacePos, que no restringe
 *     edición ni anulación de ventas por tipo de usuario.
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
  private readonly logger = new Logger(SalesController.name);

  constructor(
    private readonly salesService: SalesService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

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
    const { sale, lines, payments, credit, creditNotes } = await this.salesService.findOne(
      id,
      companyId,
    );
    return toSaleResponseDto(sale, lines, payments, credit, creditNotes);
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

    // Notificación de tiempo real (best-effort): tras el commit de la venta,
    // señala a los clientes que su lista de tickets cambió para que la
    // invaliden. NUNCA debe romper la creación: cualquier fallo de socket se
    // traga y se loguea. El `sellerId` es el creador (actor). `company_id`
    // viene del JWT, jamás del cliente.
    try {
      this.realtimeGateway.emitTicketChanged(companyId, currentUser.user_id, {
        invoiceId: Number(sale.id),
        ticketNumber: sale.ticket_number,
      });
    } catch (error) {
      this.logger.warn(
        `Fallo emitiendo ticket:changed (venta ${String(sale.id)}, company ${companyId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return toCreateSaleResponseDto(Number(sale.id), sale.ticket_number);
  }

  // --------------------------------------------------------------------------
  // PUT /sales/:id
  // --------------------------------------------------------------------------

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Editar un ticket. ORDER: reemplazo total de líneas + cliente. SALE: emite ' +
      'NC PARTIAL_VOID (o FULL_VOID) / ND ADDITION según el delta, ajusta inventario ' +
      'y registra reembolso/cobro en la cuenta indicada por *_correction_source. ' +
      'Retorna shape minimal { success, message, creditNoteId, creditNoteNumber, ' +
      'debitNoteId, debitNoteNumber } — paridad con `editTicket` de PlacePos. Para ' +
      'el aggregate completo usa `GET /sales/:id` con el id editado.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateSaleDto })
  @ApiResponse({ status: HttpStatus.OK, type: UpdateSaleResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta no encontrada' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'override_margin solo permitido a owner/superadmin',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'Venta con FULL_VOID activa, cliente con abonos, margen bajo mínimo, ' +
      'cuenta inválida o sin saldo para reembolso',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSaleDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<UpdateSaleResponseDto> {
    const result = await this.salesService.update(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      type: currentUser.type,
    });
    return toUpdateSaleResponseDto(result);
  }

  // --------------------------------------------------------------------------
  // PATCH /sales/:id/note
  // --------------------------------------------------------------------------

  @Patch(':id/note')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Actualizar SOLO la nota a nivel ticket (sale_invoices.notes) de una venta. ' +
      'El cajero la agrega desde el modal de éxito post-venta. Idempotente: ' +
      'reenviar el mismo notes deja el mismo estado; null o cadena vacía limpia ' +
      'la nota. Retorna { id, notes }.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateSaleNoteDto })
  @ApiResponse({ status: HttpStatus.OK, description: '{ id, notes }' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta no encontrada' })
  async updateNote(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSaleNoteDto,
    @CurrentCompany() companyId: number,
  ): Promise<UpdateSaleNoteActionResult> {
    return this.salesService.updateNote(id, companyId, dto.notes ?? null);
  }

  // --------------------------------------------------------------------------
  // POST /sales/:id/void
  // --------------------------------------------------------------------------

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Anular un ticket. ORDER: soft-delete directo. SALE: emite NC FULL_VOID, ' +
      'devuelve stock y reversa CASH si aplica (los pagos TRANSFER no se reversan ' +
      'automáticamente — paridad PlacePos). Retorna { success, message, creditNoteId, ' +
      'creditNoteNumber }; los campos NC son null para anulación de ORDER.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: VoidSaleResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Venta ya anulada, NC FULL_VOID existente o caja sin saldo para reembolso',
  })
  async void(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: VoidSaleDto | undefined,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<VoidSaleResponseDto> {
    const result = await this.salesService.void(
      id,
      companyId,
      {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
        type: currentUser.type,
      },
      body?.reason ?? null,
      body?.refund_source ?? null,
    );
    return toVoidSaleResponseDto(result);
  }

  // --------------------------------------------------------------------------
  // DELETE /sales/:saleId/payments/:paymentId — reverso de un pago
  // --------------------------------------------------------------------------

  @Delete(':saleId/payments/:paymentId')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Reversa (soft-delete) un pago individual de una venta y devuelve el dinero a la cuenta ' +
      'ORIGINAL del pago (caja/banco/billetera). Recalcula el saldo de la venta: si queda saldo ' +
      'pendiente la venta pasa a PENDIENTE/CRÉDITO. Valida fondos antes de descontar. ' +
      'Idempotente por client_operation_id. Espejo placepos.',
  })
  @ApiParam({ name: 'saleId', type: 'integer' })
  @ApiParam({ name: 'paymentId', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Pago reversado.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta o pago no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Venta anulada, o la cuenta no tiene saldo suficiente para reversar.',
  })
  async deletePayment(
    @Param('saleId', ParseIntPipe) saleId: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() body: DeleteSalePaymentDto | undefined,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<DeleteSalePaymentResult> {
    return this.salesService.deletePayment(
      saleId,
      paymentId,
      companyId,
      {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
        type: currentUser.type,
      },
      body?.reason ?? null,
      body?.client_operation_id ?? null,
    );
  }

  // --------------------------------------------------------------------------
  // POST /sales/:saleId/collect — re-cobro del saldo pendiente
  // --------------------------------------------------------------------------

  @Post(':saleId/collect')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Re-cobra el saldo pendiente de una venta SALE con uno o varios tenders (CASH/TRANSFER). ' +
      'NO regenera folio ni descuenta inventario. Acredita los destinos (efectivo → caja del ' +
      'usuario; transfer → banco) y recalcula el estado de cobro. Idempotente por ' +
      'client_operation_id. Espejo placepos.',
  })
  @ApiParam({ name: 'saleId', type: 'integer' })
  @ApiBody({ type: CollectSaleBalanceDto })
  @ApiResponse({ status: HttpStatus.OK, description: 'Cobro registrado.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Venta anulada/no SALE, sin saldo pendiente, o el monto excede el saldo.',
  })
  async collect(
    @Param('saleId', ParseIntPipe) saleId: number,
    @Body() dto: CollectSaleBalanceDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CollectSaleBalanceResult> {
    return this.salesService.collect(saleId, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      type: currentUser.type,
    });
  }
}
