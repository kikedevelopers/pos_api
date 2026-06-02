import {
  Body,
  Controller,
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

import { ArchivePurchaseDto } from './dto/archive-purchase.dto';
import { BulkPurchasePaymentsDto } from './dto/bulk-purchase-payments.dto';
import {
  BulkPurchasePaymentsResponseDto,
  toBulkPurchasePaymentsResponseDto,
} from './dto/bulk-purchase-payments-response.dto';
import { CreatePurchasePaymentDto } from './dto/create-purchase-payment.dto';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { ListPurchasesQueryDto } from './dto/list-purchases-query.dto';
import { PurchaseResponseDto, toPurchaseResponseDto } from './dto/purchase-response.dto';
import { ReceivePurchaseDto } from './dto/receive-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { PurchasesService } from './purchases.service';

/**
 * Endpoints `/purchases`. Espejo de PlacePos `purchases.routes.ts`.
 *
 * Roles:
 *   - `GET /purchases`, `GET /purchases/:id`, `GET /purchases/by-supplier/:supplierId`:
 *     cualquier autenticado (los empleados de POS típicamente solo ven;
 *     PlacePos no distingue por rol en GETs).
 *   - `POST /purchases`, `PUT /purchases/:id/receive`,
 *     `POST /purchases/:id/payments`, `PUT /purchases/:id/archive`:
 *     solo `owner` y `manager`. El `employee` operativo no toca compras.
 *     Paridad PlacePos: NO se usa el verbo DELETE.
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
    const { purchase, lines, credit, payments, carrier, carrierCredit } =
      await this.purchasesService.findOne(id, companyId);
    return toPurchaseResponseDto(
      purchase,
      lines,
      credit,
      payments,
      carrier ?? null,
      carrierCredit ?? null,
    );
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
  // PUT /purchases/:id/archive
  // --------------------------------------------------------------------------

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Archivar (anular) una compra. Reembolsa pagos a la caja indicada. Paridad PlacePos.',
    description:
      'Marca is_deleted=true, revierte deuda del proveedor y, si hay pagos aplicados a la compra o al transportista, los reembolsa a la caja indicada en refund_source_*. Si la compra estaba RECEIVED, revierte stock (usar force_stock_adjustment=true para clampear a 0). Todo dentro de una transacción SERIALIZABLE.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: ArchivePurchaseDto, required: false })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Payload `{ archived: true }` espejando PlacePos.',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Compra no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'Falta refund_source cuando hay pagos, o reversa de stock dejaría inventario negativo.',
  })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ArchivePurchaseDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{ archived: true }> {
    await this.purchasesService.archive(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      type: currentUser.type ?? null,
    });
    return { archived: true };
  }

  // --------------------------------------------------------------------------
  // POST /purchases/bulk-payments
  // --------------------------------------------------------------------------
  //
  // IMPORTANTE: ruta FIJA — debe declararse ANTES de `:id/payments` para que
  // el matching de Express/Nest no la confunda con `purchase_id = 'bulk-payments'`.

  @Post('bulk-payments')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Aplica múltiples abonos a compras en UNA sola transacción atómica (todo o nada).',
    description:
      'Espejo PlacePos: si CUALQUIER abono falla (saldo insuficiente, monto excede balance, fuente archivada, etc.), TODOS revierten. Pre-valida saldos agrupados por purchase_id ANTES de abrir la transacción para devolver mensajes legibles. Idempotencia per-item via uuid (paridad con el flujo single).',
  })
  @ApiBody({ type: BulkPurchasePaymentsDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: BulkPurchasePaymentsResponseDto,
    description:
      'Lote procesado. Devuelve por cada compra el payment_id, payment_number y nuevo credit_status.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Saldo agrupado excede balance, compra inexistente o pagada',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Saldo insuficiente en alguna fuente, race condition de pagos, etc.',
  })
  async bulkPayments(
    @Body() dto: BulkPurchasePaymentsDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<BulkPurchasePaymentsResponseDto> {
    const result = await this.purchasesService.processBulkPayments(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toBulkPurchasePaymentsResponseDto(result.processed, result.payments);
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
  // PUT /purchases/:id
  // --------------------------------------------------------------------------
  //
  // IMPORTANTE: este endpoint catch-all paramétrico va AL FINAL — debe
  // declararse DESPUÉS de los segmentos fijos (`:id/receive`, `:id/archive`,
  // `:id/payments`) para no interceptar sus rutas.

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Editar una compra: reemplaza líneas, recalcula totales y reconcilia el credit.',
    description:
      'Espejo PlacePos editPurchase. Replace total de líneas, ajuste diferencial de inventario (cuando la compra está RECEIVED), recálculo de totales con Big.js, reconciliación del PurchaseCredit y supplier.accumulated_debt. Si el nuevo total queda por debajo de lo ya pagado, se reembolsa el excedente a la cuenta indicada en refund_source_*. supplier_id es inmutable.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdatePurchaseDto })
  @ApiResponse({ status: HttpStatus.OK, type: PurchaseResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Compra no encontrada' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido o productos inexistentes',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'Compra archivada, total <= 0, force_stock_adjustment sin rol admin, o falta refund_source cuando hay excedente.',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePurchaseDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<PurchaseResponseDto> {
    const { purchase, lines, credit, payments, carrier, carrierCredit } =
      await this.purchasesService.update(id, dto, companyId, {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
        type: currentUser.type ?? null,
      });
    return toPurchaseResponseDto(
      purchase,
      lines,
      credit,
      payments,
      carrier ?? null,
      carrierCredit ?? null,
    );
  }
}
