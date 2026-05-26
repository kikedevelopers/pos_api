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

import { CreateDeliveryDto } from './dto/create-delivery.dto';
import {
  DeliveryPrefillResponseDto,
  DeliveryResponseDto,
  toDeliveryResponseDto,
} from './dto/delivery-response.dto';
import { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto';
import { DeliveriesService } from './deliveries.service';

/**
 * Endpoints `/deliveries` — Domicilios (entregas). Espejo cloud del feature de
 * PlacePos, multi-tenant.
 *
 * Roles:
 *   - GET / GET /:id / prefill / POST: `owner`, `manager`, `employee` (el
 *     cajero registra y consulta domicilios).
 *   - PUT /:id/archive: `owner`, `manager` (anulación con reverso de caja —
 *     operación administrativa).
 *
 * Multi-tenancy: `company_id` (tenant) se propaga vía `@CurrentCompany()`.
 * OJO: el query param `company_id` de `GET /deliveries` es el id del
 * DOMICILIARIO, NO el tenant.
 */
@ApiTags('deliveries')
@ApiBearerAuth('bearer')
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  // --------------------------------------------------------------------------
  // GET /deliveries
  // --------------------------------------------------------------------------

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Listar domicilios de la company con filtros (company_id=domiciliario, payment_method, fechas, search, include_archived).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [DeliveryResponseDto] })
  async findAll(
    @Query() query: ListDeliveriesQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<DeliveryResponseDto[]> {
    const rows = await this.deliveriesService.findAllDeliveries(companyId, query);
    return rows.map(toDeliveryResponseDto);
  }

  // --------------------------------------------------------------------------
  // GET /deliveries/prefill/:invoiceId
  // --------------------------------------------------------------------------
  // IMPORTANTE: ruta estática antes de `/:id` para que el matcher no la
  // capture como parámetro.

  @Get('prefill/:invoiceId')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Datos para pre-llenar el formulario de domicilio a partir de una venta.',
  })
  @ApiParam({ name: 'invoiceId', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: DeliveryPrefillResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Venta no encontrada' })
  prefill(
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
    @CurrentCompany() companyId: number,
  ): Promise<DeliveryPrefillResponseDto> {
    return this.deliveriesService.prefill(invoiceId, companyId);
  }

  // --------------------------------------------------------------------------
  // GET /deliveries/:id
  // --------------------------------------------------------------------------

  @Get(':id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Detalle de un domicilio.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: DeliveryResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Domicilio no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<DeliveryResponseDto> {
    const row = await this.deliveriesService.findDelivery(id, companyId);
    return toDeliveryResponseDto(row);
  }

  // --------------------------------------------------------------------------
  // POST /deliveries
  // --------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Registrar un domicilio. Si payment_method=cash_register, descuenta la caja del cajero (transacción atómica + CashRegisterLog).',
  })
  @ApiBody({ type: CreateDeliveryDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: DeliveryResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Domiciliario o venta no encontrados' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Saldo insuficiente en la caja.',
  })
  async create(
    @Body() dto: CreateDeliveryDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<DeliveryResponseDto> {
    const row = await this.deliveriesService.createDelivery(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toDeliveryResponseDto(row);
  }

  // --------------------------------------------------------------------------
  // PUT /deliveries/:id/archive
  // --------------------------------------------------------------------------

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Anular (archivar) un domicilio. Si fue pagado de caja, revierte el egreso (ingreso a la caja original).',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Payload `{ archived: true }`.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Domicilio no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Domicilio ya anulado o caja original inexistente',
  })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{ archived: true }> {
    return this.deliveriesService.archiveDelivery(id, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
  }
}
