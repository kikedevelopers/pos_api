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
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CarriersService } from './carriers.service';
import {
  ArchiveCarrierResponseDto,
  CarrierDetailResponseDto,
  CarrierResponseDto,
  CarriersAnalyticsResponseDto,
  toCarrierResponseDto,
} from './dto/carrier-response.dto';
import { CreateCarrierDto } from './dto/create-carrier.dto';
import { UpdateCarrierDto } from './dto/update-carrier.dto';

/**
 * Endpoints `/carriers`. Espejo del contrato PlacePos.
 *
 * Orden de rutas: `/analytics` se declara ANTES que `:id` para evitar que
 * Nest haga match de `:id = 'analytics'` y `ParseIntPipe` lance 400.
 */
@ApiTags('carriers')
@ApiBearerAuth('bearer')
@Controller('carriers')
@Roles('owner', 'manager', 'employee')
export class CarriersController {
  constructor(private readonly carriersService: CarriersService) {}

  @Get('analytics')
  @ApiOperation({ summary: 'KPIs de transportistas para dashboard' })
  @ApiResponse({ status: HttpStatus.OK, type: CarriersAnalyticsResponseDto })
  async analytics(@CurrentCompany() companyId: number): Promise<CarriersAnalyticsResponseDto> {
    return this.carriersService.getAnalytics(companyId);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar carriers no archivados con agregados (deuda y compras)',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [CarrierResponseDto] })
  async findAll(@CurrentCompany() companyId: number): Promise<CarrierResponseDto[]> {
    const items = await this.carriersService.findAll(companyId);
    return items.map((it) =>
      toCarrierResponseDto(it.carrier, {
        pending_balance: it.pending_balance,
        total_purchases: it.total_purchases,
      }),
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle del carrier (créditos + últimos 10 pagos)',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: CarrierDetailResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Transportista no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<CarrierDetailResponseDto> {
    const detail = await this.carriersService.findOne(id, companyId);
    return {
      ...toCarrierResponseDto(detail.carrier, {
        pending_balance: detail.pending_balance,
        total_purchases: detail.total_purchases,
      }),
      credits: detail.credits,
      recent_payments: detail.recent_payments,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @RequirePermission('canAccessCarriers')
  @ApiOperation({ summary: 'Crear carrier' })
  @ApiBody({ type: CreateCarrierDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CarrierResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Nombre vacío o inválido' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async create(
    @Body() dto: CreateCarrierDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CarrierResponseDto> {
    const carrier = await this.carriersService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    // Recién creado: agregados = 0.
    return toCarrierResponseDto(carrier, { pending_balance: 0, total_purchases: 0 });
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @RequirePermission('canAccessCarriers')
  @ApiOperation({ summary: 'Actualizar carrier' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateCarrierDto })
  @ApiResponse({ status: HttpStatus.OK, type: CarrierResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Nombre inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Transportista no encontrado' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCarrierDto,
    @CurrentCompany() companyId: number,
  ): Promise<CarrierResponseDto> {
    const carrier = await this.carriersService.update(id, dto, companyId);
    // Tras update: refrescamos agregados con `findOne` para no quedar
    // desincronizados. Coste extra mínimo (1 select sobre carrier_credits).
    const detail = await this.carriersService.findOne(Number(carrier.id), companyId);
    return toCarrierResponseDto(carrier, {
      pending_balance: detail.pending_balance,
      total_purchases: detail.total_purchases,
    });
  }

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @RequirePermission('canAccessCarriers')
  @ApiOperation({
    summary: 'Archivar carrier',
    description: '422 si el carrier tiene deuda pendiente (balance > 0).',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: ArchiveCarrierResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Transportista no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Carrier tiene deuda pendiente',
  })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ArchiveCarrierResponseDto> {
    return this.carriersService.archive(id, companyId);
  }
}
