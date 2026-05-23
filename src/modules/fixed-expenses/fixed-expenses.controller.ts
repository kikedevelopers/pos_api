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
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CreateFixedExpenseDto } from './dto/create-fixed-expense.dto';
import {
  FixedExpensePeriodResponseDto,
  toFixedExpensePeriodResponseDto,
} from './dto/fixed-expense-period-response.dto';
import { PayFixedExpensePeriodDto } from './dto/pay-fixed-expense-period.dto';
import {
  FixedExpenseResponseDto,
  toFixedExpenseResponseDto,
} from './dto/fixed-expense-response.dto';
import { UpdateFixedExpenseDto } from './dto/update-fixed-expense.dto';
import { FixedExpensesService } from './fixed-expenses.service';

/**
 * Endpoints `/fixed-expenses`. Espejo PlacePos `fixed-expenses.routes.ts`
 * con extensión cloud:
 *
 *   - `GET    /fixed-expenses`                       → listado activo + stats.
 *   - `GET    /fixed-expenses/:id`                   → detalle.
 *   - `POST   /fixed-expenses`                       → crear.
 *   - `PUT    /fixed-expenses/:id`                   → editar.
 *   - `PUT    /fixed-expenses/:id/archive`           → soft-delete.
 *   - `GET    /fixed-expenses/:id/periods`           → listar cortes del gasto.
 *   - `PUT    /fixed-expenses/:id/periods/:periodId/pay` → marcar corte pagado.
 *
 * Roles:
 *   - `GET`: owner/manager/employee (lectura).
 *   - `POST`/`PUT`/`PUT archive`: owner/manager (gestión).
 *   - `PUT periods/:id/pay`: owner/manager.
 *
 * Multi-tenancy: `@CurrentCompany()` propaga el tenant. Cualquier intento
 * cross-tenant (id de otra company) cae en 404.
 */
@ApiTags('fixed-expenses')
@ApiBearerAuth('bearer')
@Controller('fixed-expenses')
export class FixedExpensesController {
  constructor(private readonly service: FixedExpensesService) {}

  // --------------------------------------------------------------------------
  // GET /fixed-expenses
  // --------------------------------------------------------------------------

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Listar gastos fijos activos de la company. Incluye stats de cortes pendientes.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [FixedExpenseResponseDto] })
  async findAll(@CurrentCompany() companyId: number): Promise<FixedExpenseResponseDto[]> {
    const { expenses, pendingStats } = await this.service.findAll(companyId);
    return expenses.map((row) =>
      toFixedExpenseResponseDto(row, pendingStats.get(row.id) ?? { count: 0, total: 0 }),
    );
  }

  // --------------------------------------------------------------------------
  // GET /fixed-expenses/:id
  // --------------------------------------------------------------------------

  @Get(':id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Detalle de un gasto fijo.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: FixedExpenseResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Gasto fijo no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<FixedExpenseResponseDto> {
    const row = await this.service.findOne(id, companyId);
    return toFixedExpenseResponseDto(row);
  }

  // --------------------------------------------------------------------------
  // POST /fixed-expenses
  // --------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Crear un nuevo gasto fijo.' })
  @ApiBody({ type: CreateFixedExpenseDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: FixedExpenseResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  async create(
    @Body() dto: CreateFixedExpenseDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<FixedExpenseResponseDto> {
    const row = await this.service.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toFixedExpenseResponseDto(row);
  }

  // --------------------------------------------------------------------------
  // PUT /fixed-expenses/:id
  // --------------------------------------------------------------------------

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Actualizar un gasto fijo activo.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateFixedExpenseDto })
  @ApiResponse({ status: HttpStatus.OK, type: FixedExpenseResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Gasto fijo no encontrado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFixedExpenseDto,
    @CurrentCompany() companyId: number,
  ): Promise<FixedExpenseResponseDto> {
    const row = await this.service.update(id, companyId, dto);
    return toFixedExpenseResponseDto(row);
  }

  // --------------------------------------------------------------------------
  // PUT /fixed-expenses/:id/archive
  // --------------------------------------------------------------------------

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Archivar (soft-delete) un gasto fijo.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, description: '`{ archived: true }`' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Gasto fijo no encontrado' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<{ archived: true }> {
    await this.service.archive(id, companyId);
    return { archived: true };
  }

  // --------------------------------------------------------------------------
  // GET /fixed-expenses/:id/periods
  // --------------------------------------------------------------------------

  @Get(':id/periods')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar cortes (periods) de un gasto fijo.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: [FixedExpensePeriodResponseDto] })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Gasto fijo no encontrado' })
  async listPeriods(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<FixedExpensePeriodResponseDto[]> {
    const periods = await this.service.listPeriods(id, companyId);
    return periods.map(toFixedExpensePeriodResponseDto);
  }

  // --------------------------------------------------------------------------
  // PUT /fixed-expenses/:id/periods/:periodId/pay
  // --------------------------------------------------------------------------

  @Put(':id/periods/:periodId/pay')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Marcar un corte como PAGADO + materializar Expense + FinancialMovement.',
    description:
      'En UNA transacción: debita la fuente (bank/wallet/cash_register), crea el `Expense` ' +
      'con descripción "Gasto fijo: <name> — periodo <n>", emite `FinancialMovement(EXPENSE_PAYMENT)` ' +
      '(o `CashRegisterLog(EXPENSE)` para caja) y actualiza el corte con status=PAID + expense_id. ' +
      'Para `cash_register` se ignora `source_id` y se resuelve la caja del actor (paridad PlacePos).',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiParam({ name: 'periodId', type: 'integer' })
  @ApiBody({ type: PayFixedExpensePeriodDto })
  @ApiResponse({ status: HttpStatus.OK, type: FixedExpensePeriodResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Corte o gasto fijo no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Corte ya pagado o saldo insuficiente en la fuente',
  })
  async markPeriodPaid(
    @Param('id', ParseIntPipe) id: number,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Body() dto: PayFixedExpensePeriodDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<FixedExpensePeriodResponseDto> {
    const row = await this.service.markPeriodPaid(id, periodId, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toFixedExpensePeriodResponseDto(row);
  }
}
