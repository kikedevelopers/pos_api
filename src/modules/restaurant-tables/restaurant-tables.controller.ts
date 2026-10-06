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
  UseGuards,
  UseInterceptors,
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

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { RestaurantModeGuard } from '@/common/guards/restaurant-mode.guard';
import { TablesRealtimeInterceptor } from '@/modules/realtime/tables-realtime.interceptor';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CreateRestaurantTableDto } from './dto/create-restaurant-table.dto';
import {
  ArchiveRestaurantTableResponseDto,
  RestaurantTableResponseDto,
  toRestaurantTableResponseDto,
} from './dto/restaurant-table-response.dto';
import { UpdateRestaurantTableDto } from './dto/update-restaurant-table.dto';
import type { RestaurantTableScope } from './actions/find-all-restaurant-tables.action';
import { RestaurantTablesService } from './restaurant-tables.service';

/**
 * Endpoints `/restaurant-tables` — CRUD simple de mesas (módulo Salones y
 * Mesas). Solo disponible en modo restaurante (`RestaurantModeGuard` → 403 en
 * retail) y para quien tenga el permiso `canAccessSalons` (owner/superadmin
 * siempre; empleado según su rol).
 */
@ApiTags('restaurant-tables')
@ApiBearerAuth('bearer')
@Controller('restaurant-tables')
@UseGuards(RestaurantModeGuard)
@UseInterceptors(TablesRealtimeInterceptor)
@Roles('owner', 'manager', 'employee')
@RequirePermission('canAccessSalons')
export class RestaurantTablesController {
  constructor(private readonly service: RestaurantTablesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar mesas activas (todas o solo las sueltas)' })
  @ApiQuery({ name: 'scope', required: false, enum: ['all', 'loose'] })
  @ApiResponse({ status: HttpStatus.OK, type: [RestaurantTableResponseDto] })
  async findAll(
    @CurrentCompany() companyId: number,
    @Query('scope') scope?: string,
  ): Promise<RestaurantTableResponseDto[]> {
    const normalized: RestaurantTableScope = scope === 'loose' ? 'loose' : 'all';
    const tables = await this.service.findAll(companyId, normalized);
    return tables.map(toRestaurantTableResponseDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de una mesa' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: RestaurantTableResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<RestaurantTableResponseDto> {
    return toRestaurantTableResponseDto(await this.service.findOne(id, companyId));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear mesa suelta (sin salón)' })
  @ApiBody({ type: CreateRestaurantTableDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: RestaurantTableResponseDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async create(
    @Body() dto: CreateRestaurantTableDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<RestaurantTableResponseDto> {
    const table = await this.service.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toRestaurantTableResponseDto(table);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Editar nombre / nº de sillas de una mesa' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateRestaurantTableDto })
  @ApiResponse({ status: HttpStatus.OK, type: RestaurantTableResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRestaurantTableDto,
    @CurrentCompany() companyId: number,
  ): Promise<RestaurantTableResponseDto> {
    return toRestaurantTableResponseDto(await this.service.update(id, dto, companyId));
  }

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archivar una mesa (soft-delete)' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: ArchiveRestaurantTableResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ArchiveRestaurantTableResponseDto> {
    return this.service.archive(id, companyId);
  }
}
