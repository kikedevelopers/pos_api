import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AdjustCashRegisterDto } from './dto/adjust-cash-register.dto';
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
  @ApiOperation({ summary: 'Balance + base + updatedAt de la caja del actor. Espejo PlacePos.' })
  @ApiResponse({ status: HttpStatus.OK })
  async getBalance(
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{
    balance: number;
    baseAmount: number;
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

  /**
   * `POST /cash-register/adjust` — El owner fija el balance que DEBE tener SU
   * PROPIA caja (la del usuario en sesión). Calcula la diferencia con el
   * balance actual y registra CashRegisterLog `ADMIN_ADJUSTMENT` +
   * FinancialMovement `ADJUSTMENT` en una transacción atómica con lock
   * pesimista. Idempotente: si el target ya coincide, no genera rows.
   *
   * Solo `owner | superadmin`. NO lleva `@RequirePermission` a propósito: el
   * ajuste de saldo es solo-admin, igual que `POST /banks/:id/adjustments` y
   * `POST /employees/:id/cash-register/adjust`. Sin la key, el RolesGuard NO
   * delega al PermissionsGuard, así que un empleado con permiso de catálogo NO
   * puede corregir saldos.
   */
  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin')
  @ApiOperation({
    summary: 'Fijar el balance de la caja del owner (solo owner/superadmin).',
    description:
      'Genera CashRegisterLog ADMIN_ADJUSTMENT + FinancialMovement ADJUSTMENT (INCOME si el target sube, EXPENSE si baja). Transacción atómica con lock pesimista. No-op idempotente si el target coincide con el balance actual.',
  })
  @ApiBody({ type: AdjustCashRegisterDto })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner/superadmin' })
  async adjust(
    @Body() dto: AdjustCashRegisterDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{ previous_balance: number; new_balance: number; difference: number }> {
    const result = await this.cashRegisterService.adjust(
      companyId,
      currentUser.user_id,
      dto.target_balance,
      dto.reason,
      {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      },
    );
    return {
      previous_balance: result.previous_balance,
      new_balance: result.new_balance,
      difference: result.difference,
    };
  }
}
