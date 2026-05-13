import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { DashboardSalesQueryDto, SalesReportQueryDto } from './dto/sales-report-query.dto';
import { PosReportsService } from './pos-reports.service';
import type { DashboardSalesResult, SalesReportResult } from './pos-reports.service';

/**
 * Endpoints `/pos-reports` — Fase 11.3. Espejo PlacePos byte-por-byte
 * (`/pos-reports/sales`, `/pos-reports/dashboard-sales`).
 *
 * Roles: `owner` y `manager` — analítica avanzada de ventas/anulaciones.
 */
@ApiTags('pos-reports')
@ApiBearerAuth('bearer')
@Controller('pos-reports')
export class PosReportsController {
  constructor(private readonly posReportsService: PosReportsService) {}

  @Get('sales')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Listado de tickets (INVOICE + NOTE) con filtros avanzados (rango, search, ticketTypes, noteFilter, showDeleted) + summary.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  salesReport(
    @Query() query: SalesReportQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<SalesReportResult> {
    return this.posReportsService.getSalesReport(companyId, query);
  }

  @Get('dashboard-sales')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Listado de tickets con totales consolidados inline (NC resta, ND suma) + summary del dashboard de ventas.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  dashboardSales(
    @Query() query: DashboardSalesQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<DashboardSalesResult> {
    return this.posReportsService.getDashboardSales(companyId, query);
  }
}
