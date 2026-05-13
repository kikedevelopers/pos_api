import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { CreditsReportQueryDto } from './dto/credits-report-query.dto';
import { DailyClosureQueryDto } from './dto/daily-closure-query.dto';
import { ReportsService } from './reports.service';
import type { CreditsReportResult, DailyClosureResult } from './reports.service';

/**
 * Endpoints `/reports` — Fase 11.2. Espejo PlacePos byte-por-byte
 * (`/reports/daily-closure`, `/reports/credits`).
 *
 * Roles: `owner` y `manager`. Los `employee` no acceden a reportes
 * consolidados.
 *
 * Divergencia vs lo solicitado en el brief: el contrato REAL de PlacePos
 * `reports.routes.ts` solo expone `daily-closure` y `credits`. Endpoints
 * adicionales (sales/purchases/expenses/profit-margins/etc.) NO existen en
 * PlacePos; agregarlos rompería la regla §2.1 (espejo byte-por-byte). Si se
 * necesitan, se agregan como `/api/v2/reports/*` en una fase futura.
 */
@ApiTags('reports')
@ApiBearerAuth('bearer')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('daily-closure')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Cierre diario consolidado: ventas, abonos, créditos, gastos y notas de ajuste.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  dailyClosure(
    @Query() query: DailyClosureQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<DailyClosureResult> {
    return this.reportsService.getDailyClosure(companyId, query.date);
  }

  @Get('credits')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Listado de créditos con filtros (rango fechas, search, status) + summary.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  creditsReport(
    @Query() query: CreditsReportQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CreditsReportResult> {
    return this.reportsService.getCreditsReport(companyId, query);
  }
}
