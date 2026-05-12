import {
  Body,
  Controller,
  Delete,
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
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import { WalletResponseDto, toWalletResponseDto } from './dto/wallet-response.dto';
import { WalletsService } from './wallets.service';

/**
 * Endpoints `/wallets`. Espejo `wallets.routes.ts` de PlacePos.
 *
 * Roles:
 *   - `GET`: cualquier rol autenticado (POS necesita el listado).
 *   - `POST` / `PUT` / `DELETE`: `owner` y `manager`.
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
  @Roles('owner', 'manager')
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
  @Roles('owner', 'manager')
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Archivar wallet (soft-delete). Idempotente.' })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Billetera no encontrada' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<void> {
    await this.walletsService.archive(id, companyId, currentUser.user_id);
  }
}
