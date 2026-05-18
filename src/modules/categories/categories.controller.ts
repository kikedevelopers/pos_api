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
import { Roles } from '@/common/decorators/roles.decorator';
import {
  ProductResponseDto,
  toProductResponseDto,
} from '@/modules/products/dto/product-response.dto';

import { CategoriesService } from './categories.service';
import {
  ArchiveCategoryResponseDto,
  CategoryResponseDto,
  toCategoryResponseDto,
} from './dto/category-response.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * Endpoints `/categories`. Espejo del contrato PlacePos
 * (`categories.routes.ts`):
 *
 *   GET    /categories
 *   GET    /categories/:id
 *   GET    /categories/:id/products
 *   POST   /categories
 *   PUT    /categories/:id
 *   PUT    /categories/:id/archive
 *
 * Autorización:
 *   - Reads: cualquier usuario autenticado de la company (3 roles).
 *   - Mutaciones: owner o manager.
 *
 * Multi-tenancy: `@CurrentCompany()` extrae `company_id` del JWT.
 */
@ApiTags('categories')
@ApiBearerAuth('bearer')
@Controller('categories')
@Roles('owner', 'manager', 'employee')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar categorías no archivadas de la company' })
  @ApiResponse({ status: HttpStatus.OK, type: [CategoryResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async findAll(@CurrentCompany() companyId: number): Promise<CategoryResponseDto[]> {
    const categories = await this.categoriesService.findAll(companyId);
    return categories.map(toCategoryResponseDto);
  }

  @Get(':id/products')
  @ApiOperation({
    summary: 'Listar productos no archivados de la categoría',
    description: 'Incluye parent y packaging cargados.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: [ProductResponseDto] })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Categoría no encontrada' })
  async listProducts(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ProductResponseDto[]> {
    const products = await this.categoriesService.listProducts(id, companyId);
    return products.map(toProductResponseDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de una categoría' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: CategoryResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Categoría no encontrada' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoriesService.findOne(id, companyId);
    return toCategoryResponseDto(category);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Crear categoría' })
  @ApiBody({ type: CreateCategoryDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CategoryResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Nombre vacío o inválido' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async create(
    @Body() dto: CreateCategoryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoriesService.create(dto, companyId);
    return toCategoryResponseDto(category);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Renombrar categoría' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateCategoryDto })
  @ApiResponse({ status: HttpStatus.OK, type: CategoryResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Nombre inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Categoría no encontrada' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoriesService.update(id, dto, companyId);
    return toCategoryResponseDto(category);
  }

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Archivar categoría (soft-delete)' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: ArchiveCategoryResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Categoría no encontrada' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ArchiveCategoryResponseDto> {
    return this.categoriesService.archive(id, companyId);
  }
}
