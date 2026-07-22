import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { CreditsReportQueryDto } from './dto/credits-report-query.dto';
import { CustomersRfmDayTicketsQueryDto } from './dto/customers-rfm-day-tickets-query.dto';
import { CustomersRfmQueryDto } from './dto/customers-rfm-query.dto';
import { DailyClosureQueryDto } from './dto/daily-closure-query.dto';
import { ExtendedSummaryQueryDto } from './dto/extended-summary-query.dto';
import { ReportsService } from './reports.service';
import type {
  CreditsReportResult,
  CustomersRfmDayTicketsResult,
  CustomersRfmPaginatedResult,
  CustomersRfmResult,
  DailyClosureResult,
  ExtendedSummaryResult,
  SalesByHourResult,
} from './reports.service';

/**
 * Endpoints `/reports` — Fase 11.2. Espejo PlacePos byte-por-byte
 * (`/reports/daily-closure`, `/reports/credits`, `/reports/customers-rfm`,
 * `/reports/customers-rfm/day-tickets`).
 *
 * Roles: `owner` y `manager`. Los `employee` no acceden a reportes
 * consolidados.
 *
 * Divergencia vs lo solicitado en el brief: el contrato REAL de PlacePos
 * `reports.routes.ts` solo expone `daily-closure`, `credits` y los dos de
 * RFM. Endpoints adicionales (sales/purchases/expenses/profit-margins/etc.)
 * NO existen en PlacePos; agregarlos rompería la regla §2.1 (espejo
 * byte-por-byte). Si se necesitan, se agregan como `/api/v2/reports/*` en
 * una fase futura.
 */
@ApiTags('reports')
@ApiBearerAuth('bearer')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('daily-closure')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessDailyClosureReport')
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

  @Get('sales-by-hour')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessDailyClosureReport')
  @ApiOperation({
    summary: 'Venta del día por hora (0–23, hora Colombia) para el gráfico de venta por horas.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  salesByHour(
    @Query() query: DailyClosureQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<SalesByHourResult> {
    return this.reportsService.getSalesByHour(companyId, query.date);
  }

  @Get('extended-summary')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessDailyClosureReport')
  @ApiOperation({
    summary:
      'Resumen financiero extendido sobre un rango [from, to] (hora Colombia): ventas, gastos, ganancia real, cartera, compras/transportistas y cajas.',
    description:
      'Defaults en hora Colombia: `from` = primer día del mes actual, `to` = hoy. cartera, saldosPorPagar y abonosTransportistasPendientes son point-in-time (no por rango).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  extendedSummary(
    @Query() query: ExtendedSummaryQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ExtendedSummaryResult> {
    return this.reportsService.getExtendedSummary(companyId, query.from, query.to);
  }

  @Get('credits')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessCreditsReport')
  @ApiOperation({
    summary: 'Listado de créditos (cartera) con filtros (rango fechas, search, status) + summary.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  creditsReport(
    @Query() query: CreditsReportQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CreditsReportResult> {
    return this.reportsService.getCreditsReport(companyId, query);
  }

  /**
   * IMPORTANTE: `customers-rfm/day-tickets` se declara ANTES que
   * `customers-rfm` para que el matcher de Nest priorice la ruta más
   * específica. Si se invierte, `day-tickets` cae al handler de `customers-rfm`
   * porque ambos comparten el prefijo y Nest evalúa en orden de declaración.
   */
  @Get('customers-rfm/day-tickets')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessClientsReport')
  @ApiOperation({
    summary: 'Drill-down RFM: tickets SALE de un cliente en una fecha específica.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  customersRfmDayTickets(
    @Query() query: CustomersRfmDayTicketsQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CustomersRfmDayTicketsResult> {
    return this.reportsService.getCustomersRfmDayTickets(companyId, query.customerId, query.date);
  }

  @Get('customers-rfm')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessClientsReport')
  @ApiOperation({
    summary:
      'Análisis RFM por cliente (Recency / Frequency / Monetary) en rango [from, to] (default 90d).',
    description:
      'Sin `limit`/`offset` → array completo `{ from, to, referenceDate, customers[] }` (paridad PlacePos). Con `limit` y/o `offset` → response paginado `{ from, to, referenceDate, items[], total, limit, offset }`.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  customersRfm(
    @Query() query: CustomersRfmQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CustomersRfmResult | CustomersRfmPaginatedResult> {
    // Opt-in a paginación: el cliente activa el nuevo shape pasando CUALQUIERA
    // de los dos params. Si NINGUNO llega, el response es idéntico al de
    // PlacePos — preservamos paridad para clientes legacy.
    const pagination =
      query.limit !== undefined || query.offset !== undefined
        ? { limit: query.limit, offset: query.offset }
        : undefined;
    return this.reportsService.getCustomersRfm(companyId, query.from, query.to, pagination);
  }
}
