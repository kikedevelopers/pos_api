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
  UseGuards,
  UseInterceptors,
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
import { RestaurantModeGuard } from '@/common/guards/restaurant-mode.guard';
import { TablesRealtimeInterceptor } from '@/modules/realtime/tables-realtime.interceptor';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { CreateRestaurantTableDto } from '@/modules/restaurant-tables/dto/create-restaurant-table.dto';
import {
  RestaurantTableResponseDto,
  toRestaurantTableResponseDto,
} from '@/modules/restaurant-tables/dto/restaurant-table-response.dto';

import { CreateSalonDto } from './dto/create-salon.dto';
import {
  ArchiveSalonResponseDto,
  SalonDetailResponseDto,
  SalonResponseDto,
  toSalonDetailResponseDto,
  toSalonResponseDto,
} from './dto/salon-response.dto';
import { UpdateSalonDto } from './dto/update-salon.dto';
import { SalonsService } from './salons.service';

/**
 * Endpoints `/salons` — salones (agrupadores de mesas) + anclaje de mesas.
 * Solo en modo restaurante (`RestaurantModeGuard` → 403 en retail) y con el
 * permiso `canAccessSalons`.
 */
@ApiTags('salons')
@ApiBearerAuth('bearer')
@Controller('salons')
@UseGuards(RestaurantModeGuard)
@UseInterceptors(TablesRealtimeInterceptor)
@Roles('owner', 'manager', 'employee')
@RequirePermission('canAccessSalons')
export class SalonsController {
  constructor(private readonly service: SalonsService) {}

  private creator(user: AuthUser): { id: number; fullName: string } {
    return { id: user.user_id, fullName: `${user.name} ${user.lastname}`.trim() };
  }

  @Get()
  @ApiOperation({ summary: 'Listar salones con su número de mesas' })
  @ApiResponse({ status: HttpStatus.OK, type: [SalonResponseDto] })
  async findAll(@CurrentCompany() companyId: number): Promise<SalonResponseDto[]> {
    const salons = await this.service.findAll(companyId);
    return salons.map(({ salon, tableCount }) => toSalonResponseDto(salon, tableCount));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un salón con sus mesas' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: SalonDetailResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<SalonDetailResponseDto> {
    const { salon, tables } = await this.service.findOne(id, companyId);
    return toSalonDetailResponseDto(salon, tables);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear salón' })
  @ApiBody({ type: CreateSalonDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: SalonResponseDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async create(
    @Body() dto: CreateSalonDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<SalonResponseDto> {
    const salon = await this.service.create(dto, companyId, this.creator(user));
    return toSalonResponseDto(salon, 0);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renombrar salón' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateSalonDto })
  @ApiResponse({ status: HttpStatus.OK, type: SalonResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSalonDto,
    @CurrentCompany() companyId: number,
  ): Promise<SalonResponseDto> {
    const { salon, tables } = await this.service
      .update(id, dto, companyId)
      .then(async (updated) => ({
        salon: updated,
        tables: (await this.service.findOne(id, companyId)).tables,
      }));
    return toSalonResponseDto(salon, tables.length);
  }

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archivar salón (archiva sus mesas propias y desancla las ancladas)' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: ArchiveSalonResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ArchiveSalonResponseDto> {
    return this.service.archive(id, companyId);
  }

  @Post(':id/tables')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear una mesa dentro del salón (anclaje permanente)' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: CreateRestaurantTableDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: RestaurantTableResponseDto })
  async createTable(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateRestaurantTableDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<RestaurantTableResponseDto> {
    const table = await this.service.createTable(id, dto, companyId, this.creator(user));
    return toRestaurantTableResponseDto(table);
  }

  @Post(':id/tables/:tableId/attach')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anclar una mesa existente (suelta) al salón' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiParam({ name: 'tableId', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: RestaurantTableResponseDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'La mesa ya está en otro salón' })
  async attachTable(
    @Param('id', ParseIntPipe) id: number,
    @Param('tableId', ParseIntPipe) tableId: number,
    @CurrentCompany() companyId: number,
  ): Promise<RestaurantTableResponseDto> {
    return toRestaurantTableResponseDto(await this.service.attachTable(id, tableId, companyId));
  }

  @Post(':id/tables/:tableId/detach')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desanclar una mesa anclada del salón (queda suelta)' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiParam({ name: 'tableId', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: RestaurantTableResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Mesa permanente o no anclada aquí' })
  async detachTable(
    @Param('id', ParseIntPipe) id: number,
    @Param('tableId', ParseIntPipe) tableId: number,
    @CurrentCompany() companyId: number,
  ): Promise<RestaurantTableResponseDto> {
    return toRestaurantTableResponseDto(await this.service.detachTable(id, tableId, companyId));
  }
}
