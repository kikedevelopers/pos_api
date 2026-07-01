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

import {
  ProductResponseDto,
  toProductResponseDto,
} from '@/modules/products/dto/product-response.dto';

import { CreatePackagingDto } from './dto/create-packaging.dto';
import {
  ArchivePackagingResponseDto,
  PackagingResponseDto,
  toPackagingResponseDto,
} from './dto/packaging-response.dto';
import { UpdatePackagingDto } from './dto/update-packaging.dto';
import { PackagingsService } from './packagings.service';

/**
 * Endpoints de gestión de empaques. Espejo del contrato PlacePos
 * (`packagings.routes.ts`).
 *
 * Autorización:
 *   - GET → owner | manager | employee. PlacePos no restringe lectura
 *     (todos los roles pueden ver el catálogo de empaques para crear
 *     productos / compras).
 *   - POST/PUT/archive → owner | manager. PlacePos no enforza roles a
 *     nivel ruta (asume cualquier sesión es válida); aquí restringimos a
 *     owner y manager para protección defensiva — el `employee` no debe
 *     mutar el catálogo. Divergencia documentada como endurecimiento, NO
 *     como cambio de shape (los `owner`/`manager` operan idéntico).
 *
 * Multi-tenancy: `@CurrentCompany()` extrae el `company_id` del JWT. El
 * payload del cliente nunca incluye `company_id`.
 */
@ApiTags('packagings')
@ApiBearerAuth('bearer')
@Controller('packagings')
export class PackagingsController {
  constructor(private readonly packagingsService: PackagingsService) {}

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar empaques activos de la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: [PackagingResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async findAll(@CurrentCompany() companyId: number): Promise<PackagingResponseDto[]> {
    const packagings = await this.packagingsService.findAll(companyId);
    return packagings.map(toPackagingResponseDto);
  }

  @Post()
  @Roles('owner', 'manager')
  @RequirePermission('canAccessPackaging')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear empaque' })
  @ApiBody({ type: CreatePackagingDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: PackagingResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Ya existe un empaque con ese nombre (code: PACKAGING_NAME_TAKEN)',
  })
  async create(
    @Body() dto: CreatePackagingDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<PackagingResponseDto> {
    const packaging = await this.packagingsService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toPackagingResponseDto(packaging);
  }

  @Put(':id')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessPackaging')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualizar empaque' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdatePackagingDto })
  @ApiResponse({ status: HttpStatus.OK, type: PackagingResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Empaque no encontrado' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Ya existe un empaque con ese nombre (code: PACKAGING_NAME_TAKEN)',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePackagingDto,
    @CurrentCompany() companyId: number,
  ): Promise<PackagingResponseDto> {
    const packaging = await this.packagingsService.update(id, dto, companyId);
    return toPackagingResponseDto(packaging);
  }

  @Put(':id/archive')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessPackaging')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archivar empaque (soft-delete)' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: ArchivePackagingResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Empaque no encontrado' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ArchivePackagingResponseDto> {
    await this.packagingsService.archive(id, companyId);
    return { archived: true };
  }

  /**
   * `GET /packagings/:id/products` — Productos activos asociados al
   * packaging. Espejo PlacePos § 29. Incluye relations `parent` y `packaging`.
   * `category` se omite (no existe en pos_api Fase 3).
   */
  @Get(':id/products')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Listar productos asociados a un packaging',
    description:
      'Devuelve productos activos (`is_archived = false`) con `packaging_id = :id` en la company autenticada. Incluye relations `parent` y `packaging`.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: [ProductResponseDto] })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Packaging no encontrado' })
  async listProducts(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ProductResponseDto[]> {
    const products = await this.packagingsService.listProducts(id, companyId);
    return products.map(toProductResponseDto);
  }
}
