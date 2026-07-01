import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
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
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import type {
  CustomerProductHistoryResponse,
  CustomerSalesChartResponse,
} from './actions/get-customer-charts.action';
import type { CustomerSalesHistoryResponse } from './actions/get-customer-sales-history.action';
import type { CustomersAnalyticsResponse } from './actions/get-customers-analytics.action';
import { ArchiveCustomerDto } from './dto/archive-customer.dto';
import { CreateCustomerAdvanceDto } from './dto/create-customer-advance.dto';
import { CreateCustomerAdvanceResponseDto } from './dto/create-customer-advance-response.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import {
  CustomerAdvanceResponseDto,
  toCustomerAdvanceResponseDto,
} from './dto/customer-advance-response.dto';
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
// La creación (`POST`) permite además `employee` (alta rápida desde el POS);
// la edición (`PUT`) overridea con `@Roles('owner', 'manager')`.
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

  @Get('analytics')
  // IMPORTANTE: la ruta estática `/analytics` se declara ANTES de cualquier
  // `:id/...` para que NestJS no la capture como un id. Aunque NestJS hace
  // matching por path exacto, mantenemos el orden por claridad y por paridad
  // con el Express de PlacePos.
  @ApiOperation({
    summary: 'Analíticas agregadas del módulo customers',
    description:
      'Devuelve customers_count (total no-archivados), new_customers (mes actual), evolution { month_current, month_previous }.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  async getAnalytics(@CurrentCompany() companyId: number): Promise<CustomersAnalyticsResponse> {
    return this.customersService.getAnalytics(companyId);
  }

  @Get(':id/sales-history')
  // Registramos las rutas de :id/* ANTES de :id puro NO es necesario en Nest
  // (NestJS empareja por path exacto), pero las agrupamos al inicio para
  // espejar el orden de PlacePos (que sí depende del orden por ser Express
  // raw).
  @ApiOperation({
    summary: 'Histórico de ventas del cliente',
    description:
      'Invoices consolidados con NC/ND, payment_method agregado, info de crédito (status/balance) y productos concatenados. Espejo PlacePos.',
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
      'Serie diaria de total/profit/margin consolidada con NC/ND. generate_series garantiza que los días sin venta vengan en 0. Default: últimos 30 días.',
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
      'Líneas de las últimas 20 facturas del cliente con producto/cantidad/precio/total.',
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

  @Get(':id/advances')
  @ApiOperation({
    summary: 'Listar anticipos del cliente',
    description: 'Anticipos del cliente ordenados por created_at DESC. Solo lectura.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: [CustomerAdvanceResponseDto] })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente no encontrado' })
  async listAdvances(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerAdvanceResponseDto[]> {
    const advances = await this.customersService.listAdvances(id, companyId);
    return advances.map(toCustomerAdvanceResponseDto);
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
  // El alta de clientes la permite también el `employee`: el POS tiene un botón
  // de creación rápida de cliente durante la venta y la caja la opera el
  // empleado. Paridad con PlacePos, donde `POST /customers` no exige rol.
  @Roles('owner', 'manager', 'employee')
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
  @RequirePermission('canAccessCustomers')
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

  @Patch(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @RequirePermission('canAccessCustomers')
  @ApiOperation({
    summary: 'Archivar / desarchivar customer',
    description:
      'Setea is_archived. Idempotente: aplicar el mismo valor no falla. Solo owner/manager.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: ArchiveCustomerDto })
  @ApiResponse({ status: HttpStatus.OK, type: CustomerResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente no encontrado' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ArchiveCustomerDto,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customersService.archive(id, dto.is_archived, companyId);
    return toCustomerResponseDto(customer);
  }

  @Post(':id/advances')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @RequirePermission('canAccessCustomers')
  @ApiOperation({
    summary: 'Registrar anticipo de cliente',
    description:
      'Registra un ingreso de dinero como anticipo: acredita la cuenta destino (caja del cajero, banco o billetera), inserta el anticipo e incrementa advance_balance del cliente. Transacción atómica. Solo owner/manager.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: CreateCustomerAdvanceDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CreateCustomerAdvanceResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Cliente / cuenta destino no encontrado',
  })
  async createAdvance(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateCustomerAdvanceDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CreateCustomerAdvanceResponseDto> {
    const result = await this.customersService.createAdvance(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return {
      advance: toCustomerAdvanceResponseDto(result.advance),
      customer: toCustomerResponseDto(result.customer),
    };
  }
}
