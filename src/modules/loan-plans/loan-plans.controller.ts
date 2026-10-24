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
  UseGuards,
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
import { AdminLevelGuard } from '@/common/guards/admin-level.guard';
import { LenderModeGuard } from '@/common/guards/lender-mode.guard';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CreateLoanPlanDto } from './dto/create-loan-plan.dto';
import { ListLoanPlansQueryDto } from './dto/list-loan-plans-query.dto';
import { LoanPlanResponseDto, toLoanPlanResponseDto } from './dto/loan-plan-response.dto';
import { SetLoanPlanArchivedDto } from './dto/set-loan-plan-archived.dto';
import { UpdateLoanPlanDto } from './dto/update-loan-plan.dto';
import { LoanPlansService } from './loan-plans.service';

/**
 * Endpoints `/loan-plans` — planes de préstamo del PRESTAMISTA.
 *
 * Solo en modo prestamista (`LenderModeGuard` → 403 en retail/restaurante) y a
 * nivel administrador (`AdminLevelGuard`: dueño o rol Administrador): definir
 * las condiciones a las que se presta es decisión del negocio, no de caja.
 */
@ApiTags('loan-plans')
@ApiBearerAuth('bearer')
@Controller('loan-plans')
@UseGuards(LenderModeGuard, AdminLevelGuard)
@Roles('owner', 'manager', 'employee')
export class LoanPlansController {
  constructor(private readonly service: LoanPlansService) {}

  @Get()
  @ApiOperation({ summary: 'Listar planes de préstamo (activos; ?include_archived=true para todos)' })
  @ApiResponse({ status: HttpStatus.OK, type: [LoanPlanResponseDto] })
  async findAll(
    @Query() query: ListLoanPlansQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<LoanPlanResponseDto[]> {
    const plans = await this.service.findAll(companyId, query.include_archived ?? false);
    return plans.map(toLoanPlanResponseDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un plan de préstamo' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: LoanPlanResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<LoanPlanResponseDto> {
    return toLoanPlanResponseDto(await this.service.findOne(id, companyId));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear plan de préstamo' })
  @ApiBody({ type: CreateLoanPlanDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: LoanPlanResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Reglas del tipo de plan' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async create(
    @Body() dto: CreateLoanPlanDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<LoanPlanResponseDto> {
    const plan = await this.service.create(dto, companyId, {
      id: user.user_id,
      fullName: `${user.name} ${user.lastname}`.trim(),
    });
    return toLoanPlanResponseDto(plan);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Editar plan de préstamo (no afecta préstamos ya hechos)' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateLoanPlanDto })
  @ApiResponse({ status: HttpStatus.OK, type: LoanPlanResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre duplicado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLoanPlanDto,
    @CurrentCompany() companyId: number,
  ): Promise<LoanPlanResponseDto> {
    return toLoanPlanResponseDto(await this.service.update(id, dto, companyId));
  }

  @Put(':id/archive')
  @ApiOperation({ summary: 'Archivar o restaurar un plan de préstamo' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: SetLoanPlanArchivedDto })
  @ApiResponse({ status: HttpStatus.OK, type: LoanPlanResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nombre ya usado por un plan activo' })
  async setArchived(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetLoanPlanArchivedDto,
    @CurrentCompany() companyId: number,
  ): Promise<LoanPlanResponseDto> {
    return toLoanPlanResponseDto(await this.service.setArchived(id, dto.is_archived, companyId));
  }
}
