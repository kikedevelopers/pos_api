import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { AdminLevelGuard } from '@/common/guards/admin-level.guard';
import { LenderModeGuard } from '@/lending/guards/lender-mode.guard';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CreateLoanDto } from './dto/create-loan.dto';
import { ListLoansQueryDto } from './dto/list-loans-query.dto';
import { LoanResponseDto, toLoanResponseDto } from './dto/loan-response.dto';
import { LoansService } from './loans.service';

/**
 * Endpoints `/loans` — cartera de préstamos del PRESTAMISTA. Solo en modo
 * prestamista (`LenderModeGuard`) y a nivel administrador (`AdminLevelGuard`):
 * prestar mueve dinero de Tesorería.
 */
@ApiTags('loans')
@ApiBearerAuth('bearer')
@Controller('loans')
@UseGuards(LenderModeGuard, AdminLevelGuard)
@Roles('owner', 'manager', 'employee')
export class LoansController {
  constructor(private readonly service: LoansService) {}

  @Get()
  @ApiOperation({ summary: 'Cartera de préstamos (filtros opcionales: status, customer_id)' })
  @ApiResponse({ status: HttpStatus.OK, type: [LoanResponseDto] })
  async findAll(
    @Query() query: ListLoansQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<LoanResponseDto[]> {
    const { loans, customerNames } = await this.service.findAll(companyId, {
      status: query.status,
      customerId: query.customer_id,
    });
    return loans.map((loan) => toLoanResponseDto(loan, customerNames.get(Number(loan.customer_id)) ?? ''));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un préstamo' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: LoanResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<LoanResponseDto> {
    const { loan, customerName } = await this.service.findOne(id, companyId);
    return toLoanResponseDto(loan, customerName);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar un préstamo (desembolsa desde caja, banco o billetera)' })
  @ApiBody({ type: CreateLoanDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: LoanResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Fecha o monto inválidos' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cliente, plan o cuenta inexistente' })
  @ApiResponse({ status: HttpStatus.UNPROCESSABLE_ENTITY, description: 'Saldo insuficiente' })
  async create(
    @Body() dto: CreateLoanDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<LoanResponseDto> {
    const { loan, customerName } = await this.service.create(dto, companyId, {
      id: user.user_id,
      fullName: `${user.name} ${user.lastname}`.trim(),
    });
    return toLoanResponseDto(loan, customerName);
  }
}
