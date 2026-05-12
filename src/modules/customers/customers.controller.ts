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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import type {
  CustomerProductHistoryResponse,
  CustomerSalesChartResponse,
} from './actions/get-customer-charts.action';
import type { CustomerSalesHistoryResponse } from './actions/get-customer-sales-history.action';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { CustomerResponseDto, toCustomerResponseDto } from './dto/customer-response.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomersService } from './customers.service';

/**
 * Endpoints del módulo customers. Espejo del contrato PlacePos
 * (`customers.routes.ts`):
 *
 *   GET    /customers
 *   GET    /customers/:id
 *   GET    /customers/:id/sales-history
 *   GET    /customers/:id/sales-chart
 *   GET    /customers/:id/product-history
 *   POST   /customers
 *   PUT    /customers/:id
 *   PUT    /customers/:id/archive       (extensión cloud — no existe en PlacePos local)
 *
 * Autorización:
 *   - Reads (`GET *`): cualquier usuario autenticado de la company.
 *   - Mutaciones (`POST`, `PUT`): owner o manager. Los employees no gestionan
 *     CRUD de customers desde admin (sí pueden crearlos vía flujo POS, pero
 *     ese endpoint vive en otro módulo y se implementa en Fase 6).
 *
 * Multi-tenancy: `@CurrentCompany()` extrae el `company_id` del JWT y se
 * propaga a TODAS las queries del service. El cliente nunca envía company_id.
 */
@ApiTags('customers')
@ApiBearerAuth('bearer')
@Controller('customers')
// HIGH-1 auditoría: declaramos los roles permitidos a nivel de clase para
// que el `RolesGuard` rechace cualquier rol futuro no esperado por defecto.
// Las mutaciones overriden con `@Roles('owner', 'manager')` a nivel de método.
@Roles('owner', 'manager', 'employee')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'Listar customers de la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: [CustomerResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async findAll(
    @Query() query: ListCustomersQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerResponseDto[]> {
    const customers = await this.customersService.findAll(companyId, query);
    return customers.map(toCustomerResponseDto);
  }

  @Get(':id/sales-history')
  // Registramos las rutas de :id/* ANTES de :id puro NO es necesario en Nest
  // (NestJS empareja por path exacto), pero las agrupamos al inicio para
  // espejar el orden de PlacePos (que sí depende del orden por ser Express
  // raw).
  @ApiOperation({
    summary: 'Histórico de ventas del cliente',
    description:
      'Placeholder en Fase 4 (devuelve invoices: [] y summary cero). Reemplazado en Fase 6 con queries reales sobre sale_invoices.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente no encontrado' })
  async getSalesHistory(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerSalesHistoryResponse> {
    return this.customersService.getSalesHistory(id, companyId);
  }

  @Get(':id/sales-chart')
  @ApiOperation({
    summary: 'Serie temporal de ventas del cliente (chart)',
    description:
      'Placeholder en Fase 4 (devuelve points: []). Reemplazado en Fase 6 con CTE sobre sale_invoices + credit_notes.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiQuery({ name: 'startDate', required: false, example: '2026-04-01' })
  @ApiQuery({ name: 'endDate', required: false, example: '2026-05-01' })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Rango de fechas inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente no encontrado' })
  async getSalesChart(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<CustomerSalesChartResponse> {
    return this.customersService.getSalesChart(id, companyId, startDate, endDate);
  }

  @Get(':id/product-history')
  @ApiOperation({
    summary: 'Productos consumidos por el cliente',
    description:
      'Placeholder en Fase 4 (devuelve lines: []). Reemplazado en Fase 6 con join sobre sale_invoice_lines.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente no encontrado' })
  async getProductHistory(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerProductHistoryResponse> {
    return this.customersService.getProductHistory(id, companyId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener customer por id' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: CustomerResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customersService.findOne(id, companyId);
    return toCustomerResponseDto(customer);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Crear customer' })
  @ApiBody({ type: CreateCustomerDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CustomerResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async create(
    @Body() dto: CreateCustomerDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customersService.create(dto, companyId, {
      id: currentUser.user_id,
      // Snapshot textual del actor. Espeja `getCurrentUser().full_name` de
      // PlacePos.
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toCustomerResponseDto(customer);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Actualizar customer' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateCustomerDto })
  @ApiResponse({ status: HttpStatus.OK, type: CustomerResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente no encontrado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCustomerDto,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customersService.update(id, dto, companyId);
    return toCustomerResponseDto(customer);
  }

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Alternar archivado del customer (extensión cloud)',
    description:
      'Toggle puro: pasa is_archived a su valor opuesto. El frontend Electron en modo local NO usa este endpoint.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: CustomerResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente no encontrado' })
  async toggleArchive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customersService.toggleArchive(id, companyId, currentUser.user_id);
    return toCustomerResponseDto(customer);
  }
}
