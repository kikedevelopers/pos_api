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

import {
  CashRegisterLogResponseDto,
  toCashRegisterLogResponseDto,
} from './dto/cash-register-log-response.dto';
import {
  CashRegisterResponseDto,
  toCashRegisterResponseDto,
} from './dto/cash-register-response.dto';
import { CloseCashRegisterDto } from './dto/close-cash-register.dto';
import { OpenCashRegisterDto } from './dto/open-cash-register.dto';
import { CashRegisterService } from './cash-register.service';

/**
 * Endpoints `/cash-register`. Híbrido de:
 *
 *   - Espejo PlacePos (`/balance`, `/logs`).
 *   - Extensiones cloud (turnos): `/open`, `/close`, `/current`,
 *     `/history`.
 *
 * Roles:
 *   - Apertura, cierre, balance, logs, current: cualquier autenticado
 *     (employee abre/cierra su turno).
 *   - History: `owner` y `manager` (consulta administrativa).
 */
@ApiTags('cash-register')
@ApiBearerAuth('bearer')
@Controller('cash-register')
export class CashRegisterController {
  constructor(private readonly cashRegisterService: CashRegisterService) {}

  // ─── PlacePos endpoints (paridad byte-por-byte) ────────────────────────

  @Get('balance')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Balance corriente del turno abierto. Espejo PlacePos.' })
  @ApiResponse({ status: HttpStatus.OK })
  async getBalance(@CurrentCompany() companyId: number): Promise<{
    balance: number;
    updatedAt: string;
  }> {
    return this.cashRegisterService.getBalance(companyId);
  }

  @Get('logs')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Logs del turno abierto. Espejo PlacePos.' })
  @ApiQuery({ name: 'limit', type: 'integer', required: false })
  @ApiResponse({ status: HttpStatus.OK, type: [CashRegisterLogResponseDto] })
  async listLogs(
    @CurrentCompany() companyId: number,
    @Query('limit') limit?: string,
  ): Promise<CashRegisterLogResponseDto[]> {
    const parsedLimit =
      limit !== undefined && limit !== '' && !Number.isNaN(Number(limit))
        ? Number(limit)
        : undefined;
    const logs = await this.cashRegisterService.listLogs(companyId, parsedLimit);
    return logs.map(toCashRegisterLogResponseDto);
  }

  // ─── Extensiones cloud: turnos explícitos ──────────────────────────────

  @Get('current')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Turno actualmente abierto (o null).' })
  @ApiResponse({ status: HttpStatus.OK, type: CashRegisterResponseDto })
  async getCurrent(@CurrentCompany() companyId: number): Promise<CashRegisterResponseDto | null> {
    const current = await this.cashRegisterService.getCurrent(companyId);
    return current ? toCashRegisterResponseDto(current) : null;
  }

  @Get('history')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Histórico de turnos (abiertos + cerrados).' })
  @ApiQuery({ name: 'limit', type: 'integer', required: false })
  @ApiResponse({ status: HttpStatus.OK, type: [CashRegisterResponseDto] })
  async listHistory(
    @CurrentCompany() companyId: number,
    @Query('limit') limit?: string,
  ): Promise<CashRegisterResponseDto[]> {
    const parsedLimit =
      limit !== undefined && limit !== '' && !Number.isNaN(Number(limit))
        ? Number(limit)
        : undefined;
    const history = await this.cashRegisterService.listHistory(companyId, parsedLimit);
    return history.map(toCashRegisterResponseDto);
  }

  @Post('open')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Abrir un turno de caja.' })
  @ApiBody({ type: OpenCashRegisterDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CashRegisterResponseDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Ya hay caja abierta (code: CASH_REGISTER_ALREADY_OPEN)',
  })
  async open(
    @Body() dto: OpenCashRegisterDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CashRegisterResponseDto> {
    const register = await this.cashRegisterService.open(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      account: currentUser.account,
    });
    return toCashRegisterResponseDto(register);
  }

  @Post('close')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Cerrar el turno abierto.',
    description: 'Calcula expected_balance a partir de logs (affects_balance=true) y difference.',
  })
  @ApiBody({ type: CloseCashRegisterDto })
  @ApiResponse({ status: HttpStatus.OK, type: CashRegisterResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'No hay caja abierta' })
  async close(
    @Body() dto: CloseCashRegisterDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CashRegisterResponseDto> {
    const closed = await this.cashRegisterService.close(dto, companyId, currentUser.user_id);
    return toCashRegisterResponseDto(closed);
  }
}
