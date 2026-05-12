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
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CreateSalePaymentDto } from './dto/create-sale-payment.dto';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import {
  SalePaymentResponseDto,
  SaleResponseDto,
  toSalePaymentResponseDto,
  toSaleResponseDto,
} from './dto/sale-response.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { SalesService } from './sales.service';

/**
 * Endpoints `/sales`. Espejo de PlacePos `sales.routes.ts`.
 *
 * Roles:
 *   - GETs y `POST /sales/:id/payments`, `POST /sales`, `POST /sales/:id/convert`:
 *     cualquier autenticado (owner / manager / employee).
 *   - `PUT /sales/:id`, `DELETE /sales/:id`: owner y manager (no employee).
 *
 * Multi-tenancy: el `company_id` se propaga vía `@CurrentCompany()` desde
 * el JWT — nunca del payload o query.
 */
@ApiTags('sales')
@ApiBearerAuth('bearer')
@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  // --------------------------------------------------------------------------
  // GET /sales
  // --------------------------------------------------------------------------

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Listar ventas de la company. Acepta ?limit, ?ticket_type, ?customer_id, ?date_from, ?date_to, ?show_deleted.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [SaleResponseDto] })
  async findAll(
    @Query() query: ListSalesQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<SaleResponseDto[]> {
    const rows = await this.salesService.findAll(companyId, query);
    // Listado liviano: sin líneas/pagos/credit — paridad PlacePos.
    return rows.map((s) => toSaleResponseDto(s, [], [], null));
  }

  // --------------------------------------------------------------------------
  // GET /sales/by-customer/:customerId
  // --------------------------------------------------------------------------

  @Get('by-customer/:customerId')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar ventas de un cliente.' })
  @ApiParam({ name: 'customerId', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: [SaleResponseDto] })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente no encontrado' })
  async findByCustomer(
    @Param('customerId', ParseIntPipe) customerId: number,
    @CurrentCompany() companyId: number,
  ): Promise<SaleResponseDto[]> {
    const sales = await this.salesService.findByCustomer(customerId, companyId);
    return sales.map((s) => toSaleResponseDto(s, [], [], null));
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
      'Crear una venta (ORDER) con líneas + pagos opcionales. Genera SaleCredit si queda saldo.',
  })
  @ApiBody({ type: CreateSaleDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: SaleResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Cliente archivado, saldo pendiente sin customer, sobrepago, etc.',
  })
  async create(
    @Body() dto: CreateSaleDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<SaleResponseDto> {
    const { sale, lines, payments, credit } = await this.salesService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toSaleResponseDto(sale, lines, payments, credit);
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
    const { sale, lines, payments, credit } = await this.salesService.update(
      id,
      dto,
      companyId,
      currentUser.user_id,
    );
    return toSaleResponseDto(sale, lines, payments, credit);
  }

  // --------------------------------------------------------------------------
  // POST /sales/:id/convert
  // --------------------------------------------------------------------------

  @Post(':id/convert')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Convertir un ORDER en SALE. Genera nuevo folio SALE (sale_number).',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: SaleResponseDto })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'La venta ya está confirmada como SALE',
  })
  async convert(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<SaleResponseDto> {
    const { sale, lines, payments, credit } = await this.salesService.convert(
      id,
      companyId,
      currentUser.user_id,
    );
    return toSaleResponseDto(sale, lines, payments, credit);
  }

  // --------------------------------------------------------------------------
  // DELETE /sales/:id (soft)
  // --------------------------------------------------------------------------

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Anular (soft-delete) un ORDER sin pagos. Para SALE confirmada usa CreditNote.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Venta SALE o con pagos aplicados',
  })
  async softDelete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<void> {
    await this.salesService.softDelete(id, companyId, currentUser.user_id);
  }

  // --------------------------------------------------------------------------
  // POST /sales/:id/payments
  // --------------------------------------------------------------------------

  @Post(':id/payments')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Registrar un cobro adicional a una venta (idempotente vía uuid).',
    description:
      'En UNA transacción: lock venta + credit, valida saldo, acredita cuenta receptora, inserta SalePayment, FinancialMovement, actualiza SaleCredit y Customer.balance. Si llega uuid ya procesado, devuelve 200 con el pago existente.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: CreateSalePaymentDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: SaleResponseDto,
    description: 'Pago nuevo registrado.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: SaleResponseDto,
    description: 'Pago ya existente (mismo uuid). No se duplicó.',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta o cuenta no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Sin saldo pendiente, monto excede balance, etc.',
  })
  async registerPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateSalePaymentDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SaleResponseDto> {
    const result = await this.salesService.registerPayment(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    res.status(result.idempotent ? HttpStatus.OK : HttpStatus.CREATED);
    const { sale, lines, payments, credit } = result.aggregate;
    return toSaleResponseDto(sale, lines, payments, credit);
  }

  // --------------------------------------------------------------------------
  // GET /sales/:id/payments
  // --------------------------------------------------------------------------

  @Get(':id/payments')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar pagos de una venta.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: [SalePaymentResponseDto] })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta no encontrada' })
  async listPayments(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<SalePaymentResponseDto[]> {
    const payments = await this.salesService.listPayments(id, companyId);
    return payments.map(toSalePaymentResponseDto);
  }
}
