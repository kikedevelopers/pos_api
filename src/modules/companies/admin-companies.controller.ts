import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Roles } from '@/common/decorators/roles.decorator';

import { CompaniesService } from './companies.service';
import { AdminListCompaniesResponseDto } from './dto/admin-list-companies-response.dto';
import { toCompanyResponseDto } from './dto/company-response.dto';
import { ListCompaniesQueryDto } from './dto/list-companies-query.dto';

/**
 * Endpoints `/admin/companies` — únicamente accesibles al `superadmin`.
 *
 * PlacePos local NO tiene este flujo (es server LAN: una company por
 * instalación). En CLOUD el superadmin opera la plataforma multi-tenant y
 * necesita inspeccionar/listar todas las companies registradas.
 *
 * Importante: NO se usa `@CurrentCompany()` aquí — el superadmin no tiene
 * tenant. El guard `@Roles('superadmin')` enforced que solo ese rol llega.
 *
 * Roadmap futuro (no implementado todavía, sin requerimiento explícito):
 *   - `PUT /admin/companies/:id/suspend` (poner balance/operación en pausa).
 *   - `GET /admin/companies/:id` (detalle con métricas).
 *   - `GET /admin/companies/:id/stats` (cantidad de empleados, ventas, etc.).
 *   Esos endpoints se añaden cuando el panel admin los necesite.
 */
@ApiTags('admin')
@ApiBearerAuth('bearer')
@Controller('admin/companies')
export class AdminCompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  // --------------------------------------------------------------------------
  // GET /admin/companies
  // --------------------------------------------------------------------------

  @Get()
  @Roles('superadmin')
  @ApiOperation({
    summary: 'Listar TODAS las companies de la plataforma (cross-tenant).',
    description:
      'Únicamente accesible para `superadmin`. Soporta paginación simple (limit/offset) y ' +
      'búsqueda libre por nombre (ILIKE). Ordenado por `name ASC`.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AdminListCompaniesResponseDto })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Solo superadmin' })
  async list(@Query() query: ListCompaniesQueryDto): Promise<AdminListCompaniesResponseDto> {
    const result = await this.companiesService.listAll(query);
    return {
      companies: result.companies.map(toCompanyResponseDto),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }
}
