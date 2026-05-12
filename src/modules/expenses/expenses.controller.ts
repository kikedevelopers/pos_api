import {
  Body,
  Controller,
  Delete,
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
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CreateExpenseDto } from './dto/create-expense.dto';
import { ListExpensesQueryDto } from './dto/list-expenses-query.dto';
import {
  ExpenseResponseDto,
  ListExpensesResponseDto,
  toExpenseResponseDto,
} from './dto/expense-response.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { ExpensesService } from './expenses.service';

/**
 * Endpoints `/expenses` — Fase 9. Espejo de PlacePos `expenses.routes.ts`
 * adaptado a multi-tenant.
 *
 * Roles:
 *   - GETs: `owner`, `manager`, `employee`. Los empleados ven los gastos
 *     pero no los crean ni editan (paridad PlacePos donde el panel admin
 *     es exclusivo de owner/manager).
 *   - `POST`, `PUT`: `owner`, `manager` (gestión administrativa).
 *   - `DELETE` (soft-delete / anular gasto): `owner` solamente — revertir
 *     un gasto toca balances financieros y exige la firma del dueño.
 *
 * Multi-tenancy: `company_id` se propaga vía `@CurrentCompany()` desde el
 * JWT — nunca del payload o query.
 */
@ApiTags('expenses')
@ApiBearerAuth('bearer')
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  // --------------------------------------------------------------------------
  // GET /expenses
  // --------------------------------------------------------------------------

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Listar gastos de la company con filtros (search, fechas, category, source). Paginable.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ListExpensesResponseDto })
  async findAll(
    @Query() query: ListExpensesQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ListExpensesResponseDto> {
    const result = await this.expensesService.findAll(companyId, query);
    return {
      expenses: result.expenses.map(toExpenseResponseDto),
      total: result.total,
      totalAmount: result.totalAmount,
      activeCount: result.activeCount,
      limit: result.limit,
      offset: result.offset,
    };
  }

  // --------------------------------------------------------------------------
  // GET /expenses/:id
  // --------------------------------------------------------------------------

  @Get(':id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Detalle de un gasto.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: ExpenseResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Gasto no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ExpenseResponseDto> {
    const expense = await this.expensesService.findOne(id, companyId);
    return toExpenseResponseDto(expense);
  }

  // --------------------------------------------------------------------------
  // POST /expenses
  // --------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Registrar un gasto. Debita la cuenta origen, inserta Expense, FinancialMovement (bank/wallet) o CashRegisterLog (caja).',
  })
  @ApiBody({ type: CreateExpenseDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: ExpenseResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cuenta origen no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Saldo insuficiente o monto inválido',
  })
  async create(
    @Body() dto: CreateExpenseDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<ExpenseResponseDto> {
    const expense = await this.expensesService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toExpenseResponseDto(expense);
  }

  // --------------------------------------------------------------------------
  // PUT /expenses/:id
  // --------------------------------------------------------------------------

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Editar metadata de un gasto (description, category, notes). NO permite cambiar amount/source/expense_date — usar anulación + nuevo gasto.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateExpenseDto })
  @ApiResponse({ status: HttpStatus.OK, type: ExpenseResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Gasto no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Gasto anulado, no editable',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateExpenseDto,
    @CurrentCompany() companyId: number,
  ): Promise<ExpenseResponseDto> {
    const expense = await this.expensesService.update(id, dto, companyId);
    return toExpenseResponseDto(expense);
  }

  // --------------------------------------------------------------------------
  // DELETE /expenses/:id (soft-delete = anular gasto + revertir balance)
  // --------------------------------------------------------------------------

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('owner')
  @ApiOperation({
    summary: 'Anular un gasto (soft-delete is_archived=true) y revertir el balance de la cuenta.',
    description:
      'En UNA transacción: lockea la cuenta origen, acredita su balance, marca el gasto archived, registra FinancialMovement(INCOME, ADJUSTMENT) (o CashRegisterLog si fuente=caja). Rechaza si la cuenta fue archivada o no hay caja abierta.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Gasto no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Gasto ya anulado, cuenta archivada o sin caja abierta',
  })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<void> {
    await this.expensesService.softDelete(id, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
  }
}
