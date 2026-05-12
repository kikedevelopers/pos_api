import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { CreditsService } from './credits.service';
import { ListCreditsResponseDto } from './dto/credit-response.dto';
import { ListCreditsQueryDto } from './dto/list-credits-query.dto';

/**
 * Endpoints `/credits` — Fase 9. Agregador read-only que consolida
 * `sale_credits` + `purchase_credits` en una sola vista paginable.
 *
 * **Divergencia documentada respecto a PlacePos**: en PlacePos local,
 * `/credits` es POST que recibe un payload de `processCreditPayment` (procesa
 * un pago de crédito). El cloud asume ese mismo path con semántica DIFERENTE:
 * GET agregador. La razón es que en multi-tenant el dashboard necesita listar
 * créditos consolidados sin tener que llamar dos endpoints distintos. El
 * endpoint POST de PlacePos `credits` se mantendrá deshabilitado o
 * reasignado cuando se implemente la Fase 10.
 *
 * Roles: `owner`, `manager` (administradores ven créditos; los empleados
 * operativos no necesitan la vista consolidada — paridad con el panel
 * admin de PlacePos).
 */
@ApiTags('credits')
@ApiBearerAuth('bearer')
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @Get()
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Listar todos los créditos (ventas + compras) de la company. Filtrable por type, status, customer, supplier, rango de fechas.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ListCreditsResponseDto })
  async listAll(
    @Query() query: ListCreditsQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ListCreditsResponseDto> {
    return this.creditsService.listAll(companyId, query);
  }
}
