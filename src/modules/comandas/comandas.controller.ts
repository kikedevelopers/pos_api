import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HttpStatus } from '@nestjs/common';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { RestaurantModeGuard } from '@/common/guards/restaurant-mode.guard';

import { ComandasService } from './comandas.service';
import { ComandaDto } from './dto/comanda.dto';
import { FindComandasQueryDto } from './dto/find-comandas-query.dto';

/**
 * `GET /comandas` — pedidos ORDER activos (sin cobrar ni anular) de la company,
 * en orden FIFO. Solo modo restaurante (`RestaurantModeGuard` → 403 fuera de
 * modo) y solo con permiso `canAccessComandas`.
 */
@ApiTags('comandas')
@ApiBearerAuth('bearer')
@Controller('comandas')
@UseGuards(RestaurantModeGuard)
@Roles('owner', 'manager', 'employee')
@RequirePermission('canAccessComandas')
export class ComandasController {
  constructor(private readonly comandasService: ComandasService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista las comandas (pedidos ORDER activos) del día en orden FIFO.',
    description:
      'Sin `date` lista el día actual (hora Colombia). Con `date` (YYYY-MM-DD) lista ese día, ' +
      'para revisar pedidos pendientes de un día anterior.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [ComandaDto] })
  findActive(
    @CurrentCompany() companyId: number,
    @Query() query: FindComandasQueryDto,
  ): Promise<ComandaDto[]> {
    return this.comandasService.findActive(companyId, query.date);
  }
}
