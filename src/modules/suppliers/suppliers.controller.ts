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
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import type { SupplierPurchasesHistoryResponse } from './actions/get-supplier-purchases-history.action';
import type { SuppliersAnalyticsResponse } from './actions/get-suppliers-analytics.action';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { ListSuppliersQueryDto } from './dto/list-suppliers-query.dto';
import { SupplierResponseDto, toSupplierResponseDto } from './dto/supplier-response.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SuppliersService } from './suppliers.service';

/**
 * Endpoints del módulo suppliers. Espejo del contrato PlacePos
 * (`suppliers.routes.ts`):
 *
 *   GET    /suppliers
 *   GET    /suppliers/:id
 *   GET    /suppliers/:id/purchases-history    (placeholder — se completa en Fase 8)
 *   POST   /suppliers
 *   PUT    /suppliers/:id
 *   PUT    /suppliers/:id/archive
 *
 * Autorización:
 *   - Reads: cualquier usuario autenticado de la company.
 *   - Mutaciones: owner o manager.
 *
 * Multi-tenancy: `@CurrentCompany()` extrae el `company_id` del JWT.
 */
@ApiTags('suppliers')
@ApiBearerAuth('bearer')
@Controller('suppliers')
// HIGH-1 auditoría: declaración explícita de roles permitidos a nivel de
// clase. Las mutaciones overriden con `@Roles('owner', 'manager')` a nivel
// de método.
@Roles('owner', 'manager', 'employee')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  @ApiOperation({ summary: 'Listar suppliers activos de la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: [SupplierResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async findAll(
    @Query() query: ListSuppliersQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<SupplierResponseDto[]> {
    const suppliers = await this.suppliersService.findAll(companyId, query);
    return suppliers.map(toSupplierResponseDto);
  }

  @Get('analytics')
  // IMPORTANTE: ruta estática declarada ANTES de cualquier `:id/...` para
  // que NestJS no la capture como un id.
  @ApiOperation({
    summary: 'Analíticas agregadas del módulo suppliers',
    description:
      'Devuelve suppliers_count, new_suppliers (mes actual), evolution { month_current, month_previous }, total_debt y total_credit_balance.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  async getAnalytics(@CurrentCompany() companyId: number): Promise<SuppliersAnalyticsResponse> {
    return this.suppliersService.getAnalytics(companyId);
  }

  @Get(':id/purchases-history')
  @ApiOperation({
    summary: 'Histórico de compras al proveedor',
    description:
      'Placeholder en Fase 4 (purchases: [] y summary cero). Reemplazado en Fase 8 con queries reales sobre purchases.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Proveedor no encontrado' })
  async getPurchasesHistory(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<SupplierPurchasesHistoryResponse> {
    return this.suppliersService.getPurchasesHistory(id, companyId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener supplier por id' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: SupplierResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Proveedor no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<SupplierResponseDto> {
    const supplier = await this.suppliersService.findOne(id, companyId);
    return toSupplierResponseDto(supplier);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSuppliers')
  @ApiOperation({ summary: 'Crear supplier' })
  @ApiBody({ type: CreateSupplierDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: SupplierResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async create(
    @Body() dto: CreateSupplierDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<SupplierResponseDto> {
    const supplier = await this.suppliersService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toSupplierResponseDto(supplier);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSuppliers')
  @ApiOperation({ summary: 'Actualizar supplier' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateSupplierDto })
  @ApiResponse({ status: HttpStatus.OK, type: SupplierResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Proveedor no encontrado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSupplierDto,
    @CurrentCompany() companyId: number,
  ): Promise<SupplierResponseDto> {
    const supplier = await this.suppliersService.update(id, dto, companyId);
    return toSupplierResponseDto(supplier);
  }

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSuppliers')
  @ApiOperation({
    summary: 'Archivar supplier (soft-delete)',
    description: 'Paridad PlacePos: si ya está archivado, responde 404.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Payload `{ archived: true }` espejando PlacePos.',
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Proveedor no encontrado' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{ archived: true }> {
    return this.suppliersService.archive(id, companyId, currentUser.user_id);
  }
}
