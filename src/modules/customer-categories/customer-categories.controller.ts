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

import { CustomerCategoriesService } from './customer-categories.service';
import { CreateCustomerCategoryDto } from './dto/create-customer-category.dto';
import {
  ArchiveCustomerCategoryResponseDto,
  CustomerCategoryResponseDto,
  toCustomerCategoryResponseDto,
} from './dto/customer-category-response.dto';
import { UpdateCustomerCategoryDto } from './dto/update-customer-category.dto';

/**
 * Endpoints `/customer-categories` — categorías ESPECIALES de clientes.
 *
 *   GET    /customer-categories
 *   GET    /customer-categories/:id
 *   POST   /customer-categories
 *   PUT    /customer-categories/:id
 *   PUT    /customer-categories/:id/archive
 *
 * Autorización:
 *   - Reads: cualquier usuario autenticado de la company.
 *   - `POST`: owner, manager o employee. El empleado crea categorías inline
 *     desde el formulario de cliente (que también puede crear), por eso NO
 *     lleva `@RequirePermission` — mismo criterio que `POST /customers`.
 *   - `PUT` / archive: owner o manager con `canAccessCustomers`.
 *
 * Multi-tenancy: `@CurrentCompany()` extrae `company_id` del JWT.
 */
@ApiTags('customer-categories')
@ApiBearerAuth('bearer')
@Controller('customer-categories')
@Roles('owner', 'manager', 'employee')
export class CustomerCategoriesController {
  constructor(private readonly service: CustomerCategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar categorías de cliente no archivadas' })
  @ApiResponse({ status: HttpStatus.OK, type: [CustomerCategoryResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async findAll(@CurrentCompany() companyId: number): Promise<CustomerCategoryResponseDto[]> {
    const categories = await this.service.findAll(companyId);
    return categories.map(toCustomerCategoryResponseDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de una categoría de cliente' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: CustomerCategoryResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Categoría no encontrada' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerCategoryResponseDto> {
    const category = await this.service.findOne(id, companyId);
    return toCustomerCategoryResponseDto(category);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Crear categoría de cliente' })
  @ApiBody({ type: CreateCustomerCategoryDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CustomerCategoryResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Nombre vacío o inválido' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async create(
    @Body() dto: CreateCustomerCategoryDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CustomerCategoryResponseDto> {
    const category = await this.service.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toCustomerCategoryResponseDto(category);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @RequirePermission('canAccessCustomers')
  @ApiOperation({ summary: 'Renombrar categoría de cliente' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateCustomerCategoryDto })
  @ApiResponse({ status: HttpStatus.OK, type: CustomerCategoryResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Nombre inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Categoría no encontrada' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCustomerCategoryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerCategoryResponseDto> {
    const category = await this.service.update(id, dto, companyId);
    return toCustomerCategoryResponseDto(category);
  }

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @RequirePermission('canAccessCustomers')
  @ApiOperation({ summary: 'Archivar categoría de cliente (soft-delete)' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: ArchiveCustomerCategoryResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Categoría no encontrada' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ArchiveCustomerCategoryResponseDto> {
    return this.service.archive(id, companyId);
  }
}
