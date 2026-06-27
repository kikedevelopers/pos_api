import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import {
  BankAdjustmentResponseDto,
  toBankAdjustmentResponseDto,
} from './dto/bank-adjustment-response.dto';
import { BankResponseDto, toBankResponseDto } from './dto/bank-response.dto';
import { CreateBankAdjustmentDto } from './dto/create-bank-adjustment.dto';
import { CreateBankDto } from './dto/create-bank.dto';
import { UpdateBankDto } from './dto/update-bank.dto';
import { BanksService } from './banks.service';

/**
 * Endpoints de `/banks`. Espejo del contrato PlacePos (`banks.routes.ts`).
 *
 * Roles:
 *   - `GET /banks`: cualquier rol autenticado (owner / manager / employee)
 *     puede consultar — el POS necesita la lista en operación normal.
 *   - `POST /banks`, `PUT /banks/:id`, `PUT /banks/:id/archive`: solo `owner` y
 *     `manager`. El `employee` (rol operativo de caja) no toca configuración
 *     de cuentas. Paridad PlacePos: NO se usa el verbo DELETE.
 *
 * Multi-tenancy: `@CurrentCompany()` propaga el `company_id` del JWT al
 * service. El payload nunca incluye `company_id` (anti-IDOR).
 */
@ApiTags('banks')
@ApiBearerAuth('bearer')
@Controller('banks')
export class BanksController {
  constructor(private readonly banksService: BanksService) {}

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar bancos activos de la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: [BankResponseDto] })
  async findAll(@CurrentCompany() companyId: number): Promise<BankResponseDto[]> {
    const banks = await this.banksService.findAll(companyId);
    return banks.map(toBankResponseDto);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessBanks')
  @ApiOperation({ summary: 'Crear cuenta bancaria' })
  @ApiBody({ type: CreateBankDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: BankResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Ya existe banco con mismo name + account_number (code: BANK_DUPLICATE)',
  })
  async create(
    @Body() dto: CreateBankDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<BankResponseDto> {
    const bank = await this.banksService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toBankResponseDto(bank);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessBanks')
  @ApiOperation({ summary: 'Actualizar cuenta bancaria' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateBankDto })
  @ApiResponse({ status: HttpStatus.OK, type: BankResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cuenta bancaria no encontrada' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'name + account_number ya en uso (code: BANK_DUPLICATE)',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBankDto,
    @CurrentCompany() companyId: number,
  ): Promise<BankResponseDto> {
    const bank = await this.banksService.update(id, dto, companyId);
    return toBankResponseDto(bank);
  }

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessBanks')
  @ApiOperation({
    summary: 'Archivar cuenta bancaria (soft-delete). Paridad PlacePos.',
    description:
      'Setea is_archived = true. Idempotente. NO borra físicamente para preservar histórico. Responde 200 con `{ archived: true }`.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Payload `{ archived: true }` espejando PlacePos.',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cuenta bancaria no encontrada' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{ archived: true }> {
    await this.banksService.archive(id, companyId, currentUser.user_id);
    return { archived: true };
  }

  /**
   * `POST /banks/:id/adjustments` — Correcciones manuales de saldo.
   * Solo `owner | superadmin` (paridad PlacePos). Lock pesimista del bank
   * + INSERT FinancialMovement con `concept = ADJUSTMENT` y `reference_code`
   * UUIDv4. Errores:
   *   - 404: bank no existe en la company.
   *   - 422: bank archivado | EXPENSE > balance.
   */
  @Post(':id/adjustments')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'superadmin')
  @RequirePermission('canAccessBanks')
  @ApiOperation({
    summary: 'Aplicar corrección manual de saldo (solo owner/superadmin).',
    description:
      'Genera un FinancialMovement con concept ADJUSTMENT. Movement_type INCOME suma, EXPENSE resta (requiere saldo suficiente). Transacción atómica con lock pesimista.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: CreateBankAdjustmentDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: BankAdjustmentResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Cuenta bancaria no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Cuenta archivada o saldo insuficiente',
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner/superadmin' })
  async applyAdjustment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateBankAdjustmentDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<BankAdjustmentResponseDto> {
    const { bank, movement } = await this.banksService.applyAdjustment(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toBankAdjustmentResponseDto(bank, movement);
  }
}
