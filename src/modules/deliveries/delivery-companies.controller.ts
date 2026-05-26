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

import { CreateDeliveryCompanyDto } from './dto/create-delivery-company.dto';
import {
  DeliveryCompanyResponseDto,
  toDeliveryCompanyResponseDto,
} from './dto/delivery-company-response.dto';
import { ListDeliveryCompaniesQueryDto } from './dto/list-delivery-companies-query.dto';
import { UpdateDeliveryCompanyDto } from './dto/update-delivery-company.dto';
import { DeliveriesService } from './deliveries.service';

/**
 * Endpoints `/delivery-companies` — Domiciliarios (transportadoras de
 * domicilios). Espejo cloud del feature de PlacePos, multi-tenant.
 *
 * Roles:
 *   - GETs: `owner`, `manager`, `employee` (el cajero consulta domiciliarios).
 *   - POST / PUT / archive / unarchive: `owner`, `manager` (gestión
 *     administrativa del catálogo).
 *
 * Multi-tenancy: `company_id` se propaga vía `@CurrentCompany()` desde el JWT.
 * El controller es delgado: solo ruta, DTO y delegación al service.
 */
@ApiTags('delivery-companies')
@ApiBearerAuth('bearer')
@Controller('delivery-companies')
export class DeliveryCompaniesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  // --------------------------------------------------------------------------
  // GET /delivery-companies
  // --------------------------------------------------------------------------

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar domiciliarios de la company (search, include_archived).' })
  @ApiResponse({ status: HttpStatus.OK, type: [DeliveryCompanyResponseDto] })
  async findAll(
    @Query() query: ListDeliveryCompaniesQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<DeliveryCompanyResponseDto[]> {
    const rows = await this.deliveriesService.findAllCompanies(companyId, query);
    return rows.map(toDeliveryCompanyResponseDto);
  }

  // --------------------------------------------------------------------------
  // GET /delivery-companies/:id
  // --------------------------------------------------------------------------

  @Get(':id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Detalle de un domiciliario.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: DeliveryCompanyResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Domiciliario no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<DeliveryCompanyResponseDto> {
    const row = await this.deliveriesService.findCompany(id, companyId);
    return toDeliveryCompanyResponseDto(row);
  }

  // --------------------------------------------------------------------------
  // POST /delivery-companies
  // --------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Crear un domiciliario.' })
  @ApiBody({ type: CreateDeliveryCompanyDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: DeliveryCompanyResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  async create(
    @Body() dto: CreateDeliveryCompanyDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<DeliveryCompanyResponseDto> {
    const row = await this.deliveriesService.createCompany(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toDeliveryCompanyResponseDto(row);
  }

  // --------------------------------------------------------------------------
  // PUT /delivery-companies/:id
  // --------------------------------------------------------------------------

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Editar un domiciliario (reemplaza name, address, phones).' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateDeliveryCompanyDto })
  @ApiResponse({ status: HttpStatus.OK, type: DeliveryCompanyResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Domiciliario no encontrado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeliveryCompanyDto,
    @CurrentCompany() companyId: number,
  ): Promise<DeliveryCompanyResponseDto> {
    const row = await this.deliveriesService.updateCompany(id, dto, companyId);
    return toDeliveryCompanyResponseDto(row);
  }

  // --------------------------------------------------------------------------
  // PUT /delivery-companies/:id/archive
  // --------------------------------------------------------------------------

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Archivar un domiciliario (soft-delete).' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Payload `{ archived: true }`.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Domiciliario no encontrado' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{ archived: boolean }> {
    return this.deliveriesService.setCompanyArchived(id, companyId, true, currentUser.user_id);
  }

  // --------------------------------------------------------------------------
  // PUT /delivery-companies/:id/unarchive
  // --------------------------------------------------------------------------

  @Put(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Reactivar un domiciliario archivado.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Payload `{ archived: false }`.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Domiciliario no encontrado' })
  async unarchive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{ archived: boolean }> {
    return this.deliveriesService.setCompanyArchived(id, companyId, false, currentUser.user_id);
  }
}
