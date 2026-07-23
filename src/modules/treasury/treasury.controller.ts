import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { CashAccountsResult } from '@/modules/dashboard/internal/cash-accounts';

import { ListTreasuryMovementsQueryDto } from './dto/list-treasury-movements-query.dto';
import { TreasuryMovementResponseDto } from './dto/treasury-movement-response.dto';
import { TreasuryService } from './treasury.service';

/**
 * Endpoints `/treasury` — Resumen de tesorería. Espejo de
 * `placepos/src/main/server/routes/treasury.routes.ts`.
 *
 * Visión consolidada de TODAS las cajas del negocio (bancos, billeteras y cajas
 * de cajeros): saldo de cada una, total general y el feed unificado de
 * movimientos de todas las cuentas (más reciente primero).
 *
 * Roles: `owner` / `manager`. Permiso `canAccessBanks` (acceso a Tesorería) —
 * mismo gate que el ítem de menú en el front.
 */
@ApiTags('treasury')
@ApiBearerAuth('bearer')
@Controller('treasury')
@Roles('owner', 'manager')
@RequirePermission('canAccessBanks')
export class TreasuryController {
  constructor(private readonly treasuryService: TreasuryService) {}

  @Get('accounts')
  @ApiOperation({ summary: 'Saldos actuales de todas las cajas + subtotales y total general.' })
  @ApiResponse({ status: HttpStatus.OK })
  accounts(@CurrentCompany() companyId: number): Promise<CashAccountsResult> {
    return this.treasuryService.accounts(companyId);
  }

  @Get('movements')
  @ApiOperation({
    summary: 'Feed unificado de movimientos de todas las cuentas (más reciente primero).',
  })
  @ApiQuery({ name: 'from', required: false, type: 'string', description: 'Instante ISO inicial' })
  @ApiQuery({ name: 'to', required: false, type: 'string', description: 'Instante ISO final' })
  @ApiResponse({ status: HttpStatus.OK, type: [TreasuryMovementResponseDto] })
  movements(
    @Query() query: ListTreasuryMovementsQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<TreasuryMovementResponseDto[]> {
    return this.treasuryService.movements(companyId, query.from, query.to);
  }
}
