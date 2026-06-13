import { BadRequestException, Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import {
  FinancialMovementResponseDto,
  toFinancialMovementResponseDto,
} from './dto/financial-movement-response.dto';
import { ListFinancialMovementsQueryDto } from './dto/list-financial-movements-query.dto';
import { FinancialMovementsService } from './financial-movements.service';

/**
 * Endpoints de `/financial-movements`. Espejo de
 * `placepos/src/main/server/routes/financial-movements.routes.ts`.
 *
 * Solo GET — POSTs internos vienen por inyección del service desde otras
 * actions (banks, accounts, sales). El cliente no puede insertar
 * movimientos directos.
 *
 * Roles: cualquier usuario autenticado de la company (owner / manager /
 * employee) puede consultar. Razón: los empleados ven movimientos de las
 * cuentas en su rol operativo (caja, ventas).
 */
@ApiTags('financial-movements')
@ApiBearerAuth('bearer')
@Controller('financial-movements')
@Roles('owner', 'manager', 'employee')
export class FinancialMovementsController {
  constructor(private readonly financialMovementsService: FinancialMovementsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar movimientos de una cuenta' })
  @ApiQuery({ name: 'account_type', enum: ['bank', 'wallet', 'cash_register', 'external'] })
  @ApiQuery({ name: 'account_id', type: 'integer' })
  @ApiQuery({ name: 'from', required: false, type: 'string', description: 'Instante ISO inicial' })
  @ApiQuery({ name: 'to', required: false, type: 'string', description: 'Instante ISO final' })
  @ApiResponse({ status: HttpStatus.OK, type: [FinancialMovementResponseDto] })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'account_type o account_id ausente / inválido',
  })
  async list(
    @Query() query: ListFinancialMovementsQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<FinancialMovementResponseDto[]> {
    // PlacePos lanza 400 explícitos con estos mensajes — mantenerlos
    // garantiza que el frontend pueda branchear por substring si lo hace.
    if (!query.account_type) {
      throw new BadRequestException('account_type es requerido');
    }
    if (
      query.account_id === undefined ||
      query.account_id === null ||
      Number.isNaN(query.account_id)
    ) {
      throw new BadRequestException('account_id debe ser un número válido');
    }

    const movements = await this.financialMovementsService.list(
      companyId,
      query.account_type,
      query.account_id,
      query.from,
      query.to,
    );
    return movements.map(toFinancialMovementResponseDto);
  }
}
