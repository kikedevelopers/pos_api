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

import { CreateWalletAdjustmentDto } from './dto/create-wallet-adjustment.dto';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import {
  WalletAdjustmentResponseDto,
  toWalletAdjustmentResponseDto,
} from './dto/wallet-adjustment-response.dto';
import { WalletResponseDto, toWalletResponseDto } from './dto/wallet-response.dto';
import { WalletsService } from './wallets.service';

/**
 * Endpoints `/wallets`. Espejo `wallets.routes.ts` de PlacePos.
 *
 * Roles:
 *   - `GET`: cualquier rol autenticado (POS necesita el listado).
 *   - `POST` / `PUT` / `PUT /:id/archive`: `owner` y `manager`.
 *
 * Paridad PlacePos: NO se usa el verbo DELETE.
 */
@ApiTags('wallets')
@ApiBearerAuth('bearer')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar wallets activas de la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: [WalletResponseDto] })
  async findAll(@CurrentCompany() companyId: number): Promise<WalletResponseDto[]> {
    const wallets = await this.walletsService.findAll(companyId);
    return wallets.map(toWalletResponseDto);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessWallets')
  @ApiOperation({ summary: 'Crear wallet' })
  @ApiBody({ type: CreateWalletDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: WalletResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido o billetera duplicada',
  })
  async create(
    @Body() dto: CreateWalletDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<WalletResponseDto> {
    const wallet = await this.walletsService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toWalletResponseDto(wallet);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessWallets')
  @ApiOperation({ summary: 'Renombrar wallet' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateWalletDto })
  @ApiResponse({ status: HttpStatus.OK, type: WalletResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Billetera no encontrada' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWalletDto,
    @CurrentCompany() companyId: number,
  ): Promise<WalletResponseDto> {
    const wallet = await this.walletsService.update(id, dto, companyId);
    return toWalletResponseDto(wallet);
  }

  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessWallets')
  @ApiOperation({
    summary: 'Archivar wallet (soft-delete). Idempotente. Paridad PlacePos.',
    description: 'Responde 200 con `{ archived: true }`.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Payload `{ archived: true }` espejando PlacePos.',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Billetera no encontrada' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<{ archived: true }> {
    await this.walletsService.archive(id, companyId, currentUser.user_id);
    return { archived: true };
  }

  /**
   * `POST /wallets/:id/adjustments` — Correcciones manuales de saldo.
   * Solo `owner | superadmin`. Idéntico flujo a `/banks/:id/adjustments`.
   */
  @Post(':id/adjustments')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'superadmin')
  @RequirePermission('canAccessWallets')
  @ApiOperation({
    summary: 'Aplicar corrección manual de saldo (solo owner/superadmin).',
    description:
      'Genera un FinancialMovement con concept ADJUSTMENT sobre la wallet. INCOME suma, EXPENSE resta (requiere saldo suficiente). Transacción atómica con lock pesimista.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: CreateWalletAdjustmentDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: WalletAdjustmentResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Billetera no encontrada' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Billetera archivada o saldo insuficiente',
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner/superadmin' })
  async applyAdjustment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateWalletAdjustmentDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<WalletAdjustmentResponseDto> {
    const { wallet, movement } = await this.walletsService.applyAdjustment(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toWalletAdjustmentResponseDto(wallet, movement);
  }
}
