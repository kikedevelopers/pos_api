import {
  Body,
  Controller,
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

import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { SkipActiveCompanyCheck } from '@/common/decorators/skip-active-company-check.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

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
}
