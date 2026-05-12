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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CreatePurchasePaymentDto } from './dto/create-purchase-payment.dto';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { ListPurchasesQueryDto } from './dto/list-purchases-query.dto';
import {
  PurchasePaymentResponseDto,
  PurchaseResponseDto,
  toPurchasePaymentResponseDto,
  toPurchaseResponseDto,
} from './dto/purchase-response.dto';
import { ReceivePurchaseDto } from './dto/receive-purchase.dto';
import { PurchasesService } from './purchases.service';

/**
 * Endpoints `/purchases`. Espejo de PlacePos `purchases.routes.ts`.
 *
 * Roles:
 *   - `GET /purchases`, `GET /purchases/:id`, `GET /purchases/by-supplier/:supplierId`,
 *     `GET /purchases/:id/payments`: cualquier autenticado (los empleados de
 *     POS típicamente solo ven; PlacePos no distingue por rol en GETs).
 *   - `POST /purchases`, `PUT /purchases/:id/receive`,
 *     `POST /purchases/:id/payments`, `DELETE /purchases/:id`:
 *     solo `owner` y `manager`. El `employee` operativo no toca compras.
 *
 * Multi-tenancy: el `company_id` se propaga vía `@CurrentCompany()` desde el
 * JWT — nunca del payload o query.
 */
@ApiTags('purchases')
@ApiBearerAuth('bearer')
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  // --------------------------------------------------------------------------
  // GET /purchases
  // --------------------------------------------------------------------------

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Listar compras de la company. Por defecto solo con saldo pendiente; ?showAll=true devuelve todo.',
  })
  @ApiQuery({ name: 'showAll', required: false, type: Boolean })
  @ApiResponse({ status: HttpStatus.OK, type: [PurchaseResponseDto] })
  async findAll(
    @Query() query: ListPurchasesQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<PurchaseResponseDto[]> {
    const rows = await this.purchasesService.findAll(companyId, query.showAll ?? false);
    // Listado liviano: sin líneas ni pagos — paridad PlacePos.
    return rows.map(({ purchase, credit }) => toPurchaseResponseDto(purchase, [], credit, []));
  }

  // --------------------------------------------------------------------------
  // GET /purchases/by-supplier/:supplierId
  // --------------------------------------------------------------------------

  @Get('by-supplier/:supplierId')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar compras de un proveedor.' })
  @ApiParam({ name: 'supplierId', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: [PurchaseResponseDto] })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Proveedor no encontrado' })
  async findBySupplier(
    @Param('supplierId', ParseIntPipe) supplierId: number,
    @CurrentCompany() companyId: number,
  ): Promise<PurchaseResponseDto[]> {
    const purchases = await this.purchasesService.findBySupplier(supplierId, companyId);
    return purchases.map((p) => toPurchaseResponseDto(p, [], null, []));
  }

  // --------------------------------------------------------------------------
  // GET /purchases/:id
  // --------------------------------------------------------------------------

  @Get(':id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Detalle completo de una compra (líneas + credit + pagos).' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: PurchaseResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Compra no encontrada' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<PurchaseResponseDto> {
    const { purchase, lines, credit, payments } = await this.purchasesService.findOne(
      id,
      companyId,
    );
    return toPurchaseResponseDto(purchase, lines, credit, payments);
  }

  // --------------------------------------------------------------------------
  // POST /purchases
  // --------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Crear una compra (cabecera + líneas + credit), generando folio per-company.',
  })
  @ApiBody({ type: CreatePurchaseDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: PurchaseResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Proveedor archivado o subtotal de línea en cero',
  })
  async create(
    @Body() dto: CreatePurchaseDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<PurchaseResponseDto> {
    const { purchase, lines, credit, payments } = await this.purchasesService.create(
      dto,
      companyId,
      {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      },
    );
    return toPurchaseResponseDto(purchase, lines, credit, payments);
  }

  // --------------------------------------------------------------------------
  // PUT /purchases/:id/receive
  // --------------------------------------------------------------------------

  @Put(':id/receive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Marcar una compra como recibida (transportadora + receptor). Solo desde estado PENDING.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: ReceivePurchaseDto })
  @ApiResponse({ status: HttpStatus.OK, type: PurchaseResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Compra no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'La compra ya fue recibida',
  })
  async markReceived(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReceivePurchaseDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<PurchaseResponseDto> {
    const { purchase, lines, credit, payments } = await this.purchasesService.markReceived(
      id,
      dto,
      companyId,
      currentUser.user_id,
    );
    return toPurchaseResponseDto(purchase, lines, credit, payments);
  }

  // --------------------------------------------------------------------------
  // DELETE /purchases/:id (soft-delete)
  // --------------------------------------------------------------------------

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Anular (soft-delete) una compra sin pagos aplicados.',
    description:
      'Marca is_deleted = true y revierte la deuda acumulada del proveedor. Rechaza si hay pagos aplicados.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Compra no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Compra tiene pagos aplicados',
  })
  async softDelete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<void> {
    await this.purchasesService.softDelete(id, companyId, currentUser.user_id);
  }

  // --------------------------------------------------------------------------
  // POST /purchases/:id/payments
  // --------------------------------------------------------------------------

  @Post(':id/payments')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Registrar un abono a una compra (idempotente vía uuid).',
    description:
      'En UNA transacción: valida saldo, debita la fuente, inserta PurchasePayment, FinancialMovement, actualiza PurchaseCredit y Supplier.accumulated_debt. Si llega un uuid ya procesado, responde 200 con el pago existente (sin duplicar).',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: CreatePurchasePaymentDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: PurchaseResponseDto,
    description: 'Pago nuevo registrado.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: PurchaseResponseDto,
    description: 'Pago ya existente (mismo uuid). No se duplicó.',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Compra o cuenta no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Saldo insuficiente, monto excede balance pendiente, etc.',
  })
  async registerPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreatePurchasePaymentDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseResponseDto> {
    const result = await this.purchasesService.registerPayment(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    // Status code diferencia entre creación nueva y respuesta idempotente.
    res.status(result.idempotent ? HttpStatus.OK : HttpStatus.CREATED);
    const { purchase, lines, credit, payments } = result.aggregate;
    return toPurchaseResponseDto(purchase, lines, credit, payments);
  }

  // --------------------------------------------------------------------------
  // GET /purchases/:id/payments
  // --------------------------------------------------------------------------

  @Get(':id/payments')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar pagos de una compra.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: [PurchasePaymentResponseDto] })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Compra no encontrada' })
  async listPayments(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<PurchasePaymentResponseDto[]> {
    const payments = await this.purchasesService.listPayments(id, companyId);
    return payments.map(toPurchasePaymentResponseDto);
  }
}
