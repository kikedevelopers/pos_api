import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { ComparativeByDayQueryDto } from './dto/comparative-by-day-query.dto';
import { ComparativeReportQueryDto } from './dto/comparative-report-query.dto';
import { DashboardSalesQueryDto, SalesReportQueryDto } from './dto/sales-report-query.dto';
import { PosReportsService } from './pos-reports.service';
import type {
  ComparativeByDayResult,
  ComparativeReportResult,
  DashboardSalesResult,
  SalesMonthsResult,
  SalesReportResult,
} from './pos-reports.service';

/**
 * Endpoints `/pos-reports` — Fase 11.3. Espejo PlacePos byte-por-byte
 * (`/pos-reports/sales`, `/pos-reports/dashboard-sales`).
 *
 * Roles:
 *   - `/pos-reports/sales`: `owner`, `manager`, `employee` — el listado de
 *     tickets que el POS muestra a cualquier rol; el empleado solo ve sus
 *     propias ventas (filtro por created_by_id, paridad PlacePos).
 *   - `/pos-reports/dashboard-sales` y `/pos-reports/comparative`: `owner` y
 *     `manager` — analítica avanzada de ventas/anulaciones.
 */
@ApiTags('pos-reports')
@ApiBearerAuth('bearer')
@Controller('pos-reports')
export class PosReportsController {
  constructor(private readonly posReportsService: PosReportsService) {}

  @Get('sales')
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSalesReport')
  @ApiOperation({
    summary:
      'Listado de tickets (INVOICE + NOTE) con filtros avanzados (rango, search, ticketTypes, noteFilter, showDeleted) + summary.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  salesReport(
    @Query() query: SalesReportQueryDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<SalesReportResult> {
    // Paridad PlacePos (`POSReportController.salesReport`): el empleado SÍ ve el
    // reporte de ventas, pero solo sus propios tickets (filtro por
    // created_by_id en el action). owner/manager ven todo.
    return this.posReportsService.getSalesReport(companyId, query, actor);
  }

  // Declarado ANTES de otras rutas de `sales` por prolijidad: son rutas fijas y
  // no colisionan, pero el orden deja explícito que `sales/months` es propia.
  @Get('sales/months')
  @Roles('owner', 'manager', 'employee')
  // Extracto mensual: SOLO owner y rol Administrador. `canAccessSettings` es el
  // criterio que el proyecto ya usa para "es administrador" (el Administrador es
  // el único rol de fábrica que lo trae, y es inmutable; Cajero y Vendedor no).
  // El owner pasa siempre, sin depender del array de permisos.
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Meses con ventas (por fecha de venta, hora Colombia) para el extracto mensual.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  salesMonths(
    @CurrentCompany() companyId: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<SalesMonthsResult> {
    return this.posReportsService.getSalesMonths(companyId, actor);
  }

  @Get('dashboard-sales')
  @Roles('owner', 'manager')
  // Alimenta el HOME (dashboard de ventas), por eso la key es canAccessDashboard
  // y no canAccessSalesReport: un rol con acceso al Inicio pero no al informe de
  // Ventas debe poder cargar su dashboard. Lo consume la pantalla de Inicio.
  @RequirePermission('canAccessDashboard')
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

  @Get('comparative')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessComparativeReport')
  @ApiOperation({
    summary:
      'Informe Comparativo "a la fecha": período actual vs anterior de igual duración (ventas/costo/ganancia/margen) + breakdown por sub-buckets. Misma matemática que /dashboard/performance.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  comparative(
    @Query() query: ComparativeReportQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ComparativeReportResult> {
    return this.posReportsService.getComparativeReport(companyId, query);
  }

  @Get('comparative/by-day')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessComparativeReport')
  @ApiOperation({
    summary:
      'Comparativa por día: el MISMO día del mes (ej. 26) entre el mes de referencia y los anteriores (ventas/costo/ganancia/margen) con crecimiento encadenado. Misma matemática que /pos-reports/comparative.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  comparativeByDay(
    @Query() query: ComparativeByDayQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ComparativeByDayResult> {
    return this.posReportsService.getComparativeByDayReport(companyId, query);
  }
}
