import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import {
  CashRegisterLogResponseDto,
  toCashRegisterLogResponseDto,
} from './dto/cash-register-log-response.dto';
import { CashRegisterService } from './cash-register.service';

/**
 * Endpoints `/cash-register`. Paridad estricta con PlacePos: solo `/balance`
 * y `/logs`. Modelo PERMANENTE: cada user tiene UNA caja por company.
 */
@ApiTags('cash-register')
@ApiBearerAuth('bearer')
@Controller('cash-register')
export class CashRegisterController {
  constructor(private readonly cashRegisterService: CashRegisterService) {}

  @Get('balance')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Balance corriente de la caja del actor. Espejo PlacePos.' })
  @ApiResponse({ status: HttpStatus.OK })
  async getBalance(
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{
    balance: number;
    updatedAt: string;
  }> {
    return this.cashRegisterService.getBalance(companyId, currentUser.user_id);
  }

  @Get('logs')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Logs de la caja del actor. Espejo PlacePos.' })
  @ApiQuery({ name: 'limit', type: 'integer', required: false })
  @ApiResponse({ status: HttpStatus.OK, type: [CashRegisterLogResponseDto] })
  async listLogs(
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
    @Query('limit') limit?: string,
  ): Promise<CashRegisterLogResponseDto[]> {
    const parsedLimit =
      limit !== undefined && limit !== '' && !Number.isNaN(Number(limit))
        ? Number(limit)
        : undefined;
    const logs = await this.cashRegisterService.listLogs(
      companyId,
      currentUser.user_id,
      parsedLimit,
    );
    return logs.map(toCashRegisterLogResponseDto);
  }
}
