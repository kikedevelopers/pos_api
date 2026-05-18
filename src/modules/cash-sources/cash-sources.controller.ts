import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CashSourcesService } from './cash-sources.service';
import { CashSourcesResponseDto } from './dto/cash-sources-response.dto';

/**
 * Endpoint `GET /cash-sources`. Devuelve wallets/banks de la company + la
 * caja PERMANENTE del actor (si existe). Espejo PlacePos.
 *
 * Autorización: 3 roles. Read puro para construir UIs de selección de fuente
 * de pago.
 */
@ApiTags('cash-sources')
@ApiBearerAuth('bearer')
@Controller('cash-sources')
@Roles('owner', 'manager', 'employee')
export class CashSourcesController {
  constructor(private readonly cashSourcesService: CashSourcesService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar fuentes de efectivo (wallets + banks + caja del actor)',
  })
  @ApiResponse({ status: HttpStatus.OK, type: CashSourcesResponseDto })
  get(
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CashSourcesResponseDto> {
    return this.cashSourcesService.get(companyId, currentUser.user_id);
  }
}
