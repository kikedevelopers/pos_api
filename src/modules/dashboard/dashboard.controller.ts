import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { DashboardService } from './dashboard.service';
import type {
  BreakEvenProgressResult,
  ExpenseImpactResult,
  PerformanceResult,
  TodayByCashierResult,
  TodayResult,
  TopProductItem,
} from './dashboard.service';
import {
  DashboardDateQueryDto,
  DashboardRangeQueryDto,
  DashboardTopProductsQueryDto,
} from './dto/dashboard-query.dto';

/**
 * Endpoints `/dashboard` — Fase 11. Espejo byte-por-byte de
 * `placepos/src/main/server/routes/dashboard.routes.ts`.
 *
 * Roles: `owner` y `manager`. Los `employee` no tienen acceso al dashboard
 * agregado (paridad con PlacePos donde el menú admin no se les expone).
 */
@ApiTags('dashboard')
@ApiBearerAuth('bearer')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('performance')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Series temporales de ventas, ganancia, gastos y créditos generados por día con totales consolidados.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  performance(
    @Query() query: DashboardRangeQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<PerformanceResult> {
    return this.dashboardService.performance(companyId, query.from, query.to);
  }

  @Get('today')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Resumen consolidado del día (recaudo, ganancia, abonos, créditos generados).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  today(
    @Query() query: DashboardDateQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<TodayResult> {
    return this.dashboardService.today(companyId, query.date);
  }

  @Get('expense-impact')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Totales consolidados de ventas, ganancia, costo y gastos en el rango.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  expenseImpact(
    @Query() query: DashboardRangeQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ExpenseImpactResult> {
    return this.dashboardService.expenseImpact(companyId, query.from, query.to);
  }

  @Get('top-products')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Top productos por unidades netas vendidas (ajustado por NC/ND).' })
  @ApiResponse({ status: HttpStatus.OK })
  topProducts(
    @Query() query: DashboardTopProductsQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<TopProductItem[]> {
    return this.dashboardService.topProducts(companyId, query.limit);
  }

  @Get('break-even-progress')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Progreso del punto de equilibrio: ganancia real del mes/día vs meta de la empresa.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  breakEvenProgress(
    @Query() query: DashboardDateQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<BreakEvenProgressResult> {
    return this.dashboardService.breakEvenProgress(companyId, query.date);
  }

  @Get('today-by-cashier')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Resumen del día agrupado por cajero: ventas, recaudo, abonos, ganancia y créditos generados.',
    description:
      'Espejo PlacePos: `cashiers` ordenado por `totalCollected` descendente, `totals` consolida. Acceso vetado para `employee` — es una vista global del equipo.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  todayByCashier(
    @Query() query: DashboardDateQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<TodayByCashierResult> {
    return this.dashboardService.todayByCashier(companyId, query.date);
  }
}
