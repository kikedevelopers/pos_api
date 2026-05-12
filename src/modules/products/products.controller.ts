import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { BulkProductsDto, BulkProductsResponseDto } from './dto/bulk-products.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { InventoryQueryDto } from './dto/inventory-query.dto';
import {
  ArchiveProductResponseDto,
  ProductMinimalResponseDto,
  ProductResponseDto,
  SalesHistoryResponseDto,
  ToggleShowInPosResponseDto,
  toProductResponseDto,
} from './dto/product-response.dto';
import { ToggleShowInPosDto } from './dto/toggle-show-in-pos.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

/**
 * Endpoints de gestión de productos (catálogo). Espejo del contrato PlacePos
 * (`inventory.routes.ts`).
 *
 * Autorización:
 *   - GET → owner | manager | employee. Lectura del catálogo es
 *     operacional (cajeros, vendedores).
 *   - POST/PUT → owner | manager. El employee no muta el catálogo.
 *   - bulk → owner. Importaciones masivas son operación delicada.
 *
 * Multi-tenancy: `@CurrentCompany()` extrae el `company_id` del JWT.
 */
@ApiTags('inventory')
@ApiBearerAuth('bearer')
@Controller('inventory')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar productos de la company autenticada' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'include_archived', required: false, type: Boolean })
  @ApiResponse({ status: HttpStatus.OK, type: [ProductResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async findAll(
    @Query() query: InventoryQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ProductResponseDto[]> {
    const products = await this.productsService.findAll(companyId, query);
    return products.map(toProductResponseDto);
  }

  /**
   * Bulk debe ir ANTES de `:id` para evitar conflicto de matching del
   * router (`/bulk` choca con `/:id`). Espejo de PlacePos.
   */
  @Post('bulk')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Procesar batch de productos (importación)',
    description:
      'Por cada item, decide CREATE o UPDATE según match por nombre y presencia de SKU/barcode.',
  })
  @ApiBody({ type: BulkProductsDto })
  @ApiResponse({ status: HttpStatus.OK, type: BulkProductsResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  async bulk(
    @Body() dto: BulkProductsDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<BulkProductsResponseDto> {
    return this.productsService.bulkProcess(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
  }

  @Get(':id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Obtener detalle de un producto' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: ProductResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ProductResponseDto> {
    const product = await this.productsService.findById(id, companyId);
    if (!product) {
      throw new NotFoundException('Producto no encontrado.');
    }
    return toProductResponseDto(product);
  }

  /**
   * `sales-history` debe ir antes que `:id` para evitar el matching
   * `:id = "sales-history"`. Pero como aquí el path es `/:id/sales-history`
   * y NO `/sales-history`, no hay conflicto — Nest sólo matchea cuando
   * `:id` es entero (ParseIntPipe). Aún así lo definimos después del
   * `GET /:id` para mantener orden lógico.
   */
  @Get(':id/sales-history')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Historial de ventas de un producto',
    description:
      'Fase 3: placeholder vacío. Implementación real en Fase 6 cuando exista SaleInvoiceLine.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: SalesHistoryResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async salesHistory(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<SalesHistoryResponseDto> {
    return this.productsService.getSalesHistory(id, companyId);
  }

  @Post()
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear producto' })
  @ApiBody({ type: CreateProductDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: ProductMinimalResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'parent_id / packaging_id inválido' })
  async create(
    @Body() dto: CreateProductDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<ProductMinimalResponseDto> {
    const product = await this.productsService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return {
      id: Number(product.id),
      name: product.name,
      created_by: product.created_by ?? null,
      created_at: product.created_at.toISOString(),
    };
  }

  @Put(':id')
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualizar producto + precios' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateProductDto })
  @ApiResponse({ status: HttpStatus.OK, type: ProductMinimalResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido o UNIQUE colision',
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<ProductMinimalResponseDto> {
    const product = await this.productsService.update(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return {
      id: Number(product.id),
      name: product.name,
      updated_by: product.updated_by ?? null,
      updated_at: product.updated_at.toISOString(),
    };
  }

  @Put(':id/show-in-pos')
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle visibilidad en POS' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: ToggleShowInPosDto })
  @ApiResponse({ status: HttpStatus.OK, type: ToggleShowInPosResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async toggleShowInPos(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ToggleShowInPosDto,
    @CurrentCompany() companyId: number,
  ): Promise<ToggleShowInPosResponseDto> {
    await this.productsService.toggleShowInPos(id, dto.show_in_pos, companyId);
    return { id, show_in_pos: dto.show_in_pos };
  }

  @Put(':id/archive')
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archivar producto (soft-delete)' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: ArchiveProductResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ArchiveProductResponseDto> {
    await this.productsService.archive(id, companyId);
    return { archived: true };
  }
}
