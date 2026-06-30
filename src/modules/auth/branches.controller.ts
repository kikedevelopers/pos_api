import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { SkipActiveCompanyCheck } from '@/common/decorators/skip-active-company-check.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { CloneProductsToBranchAction } from '@/modules/products/actions/clone-products-to-branch.action';
import { ShareProductsToBranchAction } from '@/modules/products/actions/share-products-to-branch.action';
import {
  CloneProductsDto,
  CloneProductsResponseDto,
} from '@/modules/products/dto/clone-products.dto';
import {
  ShareListItemDto,
  ShareProductsDto,
  ShareProductsResponseDto,
  UnshareProductsDto,
  UnshareResponseDto,
} from '@/modules/products/dto/share-products.dto';

import { CreateBranchAction } from './actions/create-branch.action';
import { ListBranchesAction } from './actions/list-branches.action';
import { SetActiveBranchesAction } from './actions/set-active-branches.action';
import { SwitchBranchAction } from './actions/switch-branch.action';
import type { CompanyProfileItemDto } from './dto/auth-response.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { SetActiveBranchesDto } from './dto/set-active-branches.dto';
import { companyToCompanyProfileItemDto } from './internal/auth-mappers';

/**
 * Endpoints `/branches` — gestión multi-sucursal del owner (cloud-only).
 *
 *   GET  /branches               → companies del owner (principal + sucursales)
 *   POST /branches               → crear una sucursal
 *   POST /branches/:id/switch    → cambiar de sucursal (re-emite el JWT)
 *
 * Solo `owner` (@Roles). Los empleados no gestionan sucursales y no obtienen
 * membresías. El switch valida membresía (anti-IDOR) en su action.
 */
@ApiTags('branches')
@ApiBearerAuth('bearer')
@Controller('branches')
@Roles('owner')
// Exento del ActiveCompanyGuard: estos endpoints deben funcionar aunque el JWT
// apunte a una sucursal suspendida (para hacer switch al principal / reconciliar).
@SkipActiveCompanyCheck()
export class BranchesController {
  private readonly logger = new Logger(BranchesController.name);

  constructor(
    private readonly createBranchAction: CreateBranchAction,
    private readonly listBranchesAction: ListBranchesAction,
    private readonly switchBranchAction: SwitchBranchAction,
    private readonly setActiveBranchesAction: SetActiveBranchesAction,
    private readonly cloneProductsToBranchAction: CloneProductsToBranchAction,
    private readonly shareProductsToBranchAction: ShareProductsToBranchAction,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar las companies del owner (principal + sucursales).' })
  @ApiResponse({ status: HttpStatus.OK })
  list(@CurrentUser() user: AuthUser): Promise<CompanyProfileItemDto[]> {
    return this.listBranchesAction.execute(user.user_id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear una sucursal (nueva company) del owner.' })
  @ApiBody({ type: CreateBranchDto })
  @ApiResponse({ status: HttpStatus.CREATED })
  async create(
    @Body() dto: CreateBranchDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CompanyProfileItemDto> {
    const company = await this.createBranchAction.execute(dto, {
      userId: user.user_id,
      fullName: `${user.name} ${user.lastname ?? ''}`.trim(),
    });
    return companyToCompanyProfileItemDto(company, this.logger);
  }

  @Put('active')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reconciliar sucursales activas: el owner elige cuáles conservar.',
    description:
      'Marca las sucursales elegidas como activas y el resto como suspendidas (datos intactos). ' +
      'Valida no exceder el límite permitido y que los ids sean del propio owner.',
  })
  @ApiBody({ type: SetActiveBranchesDto })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Excede el límite o id ajeno' })
  async setActive(
    @Body() dto: SetActiveBranchesDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ updated: true }> {
    await this.setActiveBranchesAction.execute(user.user_id, dto);
    return { updated: true };
  }

  @Post(':companyId/switch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cambiar de sucursal. Re-emite un JWT con la company elegida.',
    description:
      'Valida que el owner sea miembro de la company destino (403 si no). El ' +
      'cliente reemplaza su token y recarga; el scoping pasa a la nueva sucursal.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'No es miembro de esa sucursal' })
  switch(
    @Param('companyId', ParseIntPipe) companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ access_token: string }> {
    return this.switchBranchAction.execute(user.user_id, companyId);
  }

  @Post(':branchCompanyId/clone-products')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clonar productos del negocio PRINCIPAL a una SUCURSAL.',
    description:
      'El JWT (CurrentCompany) es el ORIGEN y DEBE ser el principal (is_branch=false). ' +
      ':branchCompanyId es el DESTINO y DEBE ser una sucursal de la que el owner es miembro. ' +
      'Body { productIds?: number[] }: omitido/vacío → clona TODO el catálogo activo; ' +
      'con ids → clona esas familias (un id hijo clona su familia completa). ' +
      'Inventarios independientes (aditivo): vender en la sucursal NO afecta al principal. ' +
      'Colisión por name/sku/barcode → se omite y se reporta en skipped.',
  })
  @ApiBody({ type: CloneProductsDto })
  @ApiResponse({ status: HttpStatus.OK, type: CloneProductsResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Origen no es el principal o destino no es sucursal',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'No es owner o no es miembro de la sucursal',
  })
  cloneProducts(
    @Param('branchCompanyId', ParseIntPipe) branchCompanyId: number,
    @Body() dto: CloneProductsDto,
    @CurrentCompany() sourceCompanyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<CloneProductsResponseDto> {
    return this.cloneProductsToBranchAction.execute(
      sourceCompanyId,
      branchCompanyId,
      dto.productIds,
      {
        id: user.user_id,
        fullName: `${user.name} ${user.lastname ?? ''}`.trim(),
      },
    );
  }

  @Post(':branchCompanyId/share-products')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compartir inventario del PRINCIPAL con una SUCURSAL (solo lectura/venta).',
    description:
      'El producto sigue siendo del principal: la sucursal puede VER y VENDER, y al vender ' +
      'el stock baja en la fila del principal (única fuente de verdad). Origen = JWT (principal); ' +
      'destino = :branchCompanyId (sucursal del owner). Body { productIds?: number[] }: ' +
      'omitido/vacío → comparte TODO (1 share company-level); con ids → 1 share por producto. ' +
      'Idempotente (omite duplicados).',
  })
  @ApiBody({ type: ShareProductsDto })
  @ApiResponse({ status: HttpStatus.OK, type: ShareProductsResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Origen no es el principal o destino no es sucursal',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'No es owner o no es miembro de la sucursal',
  })
  shareProducts(
    @Param('branchCompanyId', ParseIntPipe) branchCompanyId: number,
    @Body() dto: ShareProductsDto,
    @CurrentCompany() sourceCompanyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<ShareProductsResponseDto> {
    return this.shareProductsToBranchAction.execute(
      sourceCompanyId,
      branchCompanyId,
      dto.productIds,
      {
        id: user.user_id,
        fullName: `${user.name} ${user.lastname ?? ''}`.trim(),
      },
    );
  }

  @Get(':branchCompanyId/shares')
  @ApiOperation({ summary: 'Listar los shares de inventario del principal con una sucursal.' })
  @ApiResponse({ status: HttpStatus.OK, type: [ShareListItemDto] })
  listShares(
    @Param('branchCompanyId', ParseIntPipe) branchCompanyId: number,
    @CurrentCompany() sourceCompanyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<ShareListItemDto[]> {
    return this.shareProductsToBranchAction.list(sourceCompanyId, branchCompanyId, user.user_id);
  }

  @Delete(':branchCompanyId/shares')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Descompartir: un producto (body.productId) o TODO el par (sin productId).',
  })
  @ApiBody({ type: UnshareProductsDto })
  @ApiResponse({ status: HttpStatus.OK, type: UnshareResponseDto })
  async unshareProducts(
    @Param('branchCompanyId', ParseIntPipe) branchCompanyId: number,
    @Body() dto: UnshareProductsDto,
    @CurrentCompany() sourceCompanyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<UnshareResponseDto> {
    const removed = await this.shareProductsToBranchAction.unshare(
      sourceCompanyId,
      branchCompanyId,
      dto.productId,
      user.user_id,
    );
    return { removed };
  }
}
