import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '@/common/decorators/public.decorator';

import { ListOwnersQueryDto } from '@/modules/users/dto/list-owners-query.dto';

import { DeleteTenantAction } from './actions/delete-tenant.action';
import { GetTenantDetailAction } from './actions/get-tenant-detail.action';
import { ListTenantsAction } from './actions/list-tenants.action';
import { UpdateSubscriptionAction } from './actions/update-subscription.action';
import { SuperadminDeleteTenantResponseDto } from './dto/superadmin-delete-tenant-response.dto';
import {
  SuperadminSubscriptionResponseDto,
  toSuperadminSubscriptionResponseDto,
} from './dto/superadmin-subscription-response.dto';
import { SuperadminTenantDetailDto } from './dto/superadmin-tenant-detail.dto';
import { SuperadminTenantsResponseDto } from './dto/superadmin-tenants-response.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { SuperadminSignatureGuard } from './guards/superadmin-signature.guard';

/**
 * Endpoints `/superadmin/*` para el panel kdevs-admin.
 *
 * Autenticación por FIRMA asimétrica Ed25519 (PAR DEDICADO,
 * `SUPERADMIN_SIGNING_PUBLIC_KEY`), no JWT/rol: `@Public()` salta los guards
 * globales `JwtAuthGuard` + `SubscriptionGuard`, y `SuperadminSignatureGuard`
 * exige una firma válida. El panel firma con su clave privada (que vive SOLO en
 * el navegador) cada request, incluido el body real de los PATCH.
 *
 * Operaciones cross-tenant (sin scoping por company del request): listar
 * tenants, ver detalle, ajustar vigencia de suscripción y BORRAR un tenant
 * completo (irreversible, cascada total en DB).
 */
@ApiTags('superadmin')
@Public()
@UseGuards(SuperadminSignatureGuard)
@Controller('superadmin')
export class SuperadminController {
  private readonly logger = new Logger(SuperadminController.name);

  constructor(
    private readonly listTenantsAction: ListTenantsAction,
    private readonly getTenantDetailAction: GetTenantDetailAction,
    private readonly updateSubscriptionAction: UpdateSubscriptionAction,
    private readonly deleteTenantAction: DeleteTenantAction,
  ) {}

  // --------------------------------------------------------------------------
  // GET /superadmin/tenants
  // --------------------------------------------------------------------------

  @Get('tenants')
  @ApiOperation({
    summary: 'Listar TODOS los tenants (owners + company) cross-tenant.',
    description:
      'Requiere firma superadmin válida (x-kdevs-signature/timestamp/key-id). ' +
      'Paginación limit/offset y búsqueda libre por owner y company (ILIKE). ' +
      'Incluye por tenant la vigencia de la suscripción (LEFT JOIN; puede ser null).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminTenantsResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Firma ausente/inválida/expirada' })
  async listTenants(@Query() query: ListOwnersQueryDto): Promise<SuperadminTenantsResponseDto> {
    const result = await this.listTenantsAction.execute(query);
    return {
      tenants: result.tenants,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }

  // --------------------------------------------------------------------------
  // GET /superadmin/tenants/:companyId
  // --------------------------------------------------------------------------

  @Get('tenants/:companyId')
  @ApiOperation({
    summary: 'Detalle de un tenant: company, owner, suscripción y conteos por dominio.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminTenantDetailDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  async getTenantDetail(
    @Param('companyId', ParseIntPipe) companyId: number,
  ): Promise<SuperadminTenantDetailDto> {
    return this.getTenantDetailAction.execute(companyId);
  }

  // --------------------------------------------------------------------------
  // PATCH /superadmin/tenants/:companyId/subscription
  // --------------------------------------------------------------------------

  @Patch('tenants/:companyId/subscription')
  @ApiOperation({
    summary: 'Fijar o extender la vigencia de la suscripción de un tenant.',
    description:
      'Body: { expiresAt } (fija fecha) o { extendDays } (suma días a max(now, expiresAt actual)). ' +
      'Exactamente uno de los dos.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminSubscriptionResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  async updateSubscription(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpdateSubscriptionDto,
  ): Promise<SuperadminSubscriptionResponseDto> {
    const saved = await this.updateSubscriptionAction.execute(companyId, dto);
    return toSuperadminSubscriptionResponseDto(saved);
  }

  // --------------------------------------------------------------------------
  // DELETE /superadmin/tenants/:companyId
  // --------------------------------------------------------------------------

  @Delete('tenants/:companyId')
  @ApiOperation({
    summary: 'Borrar un tenant COMPLETO (irreversible: cascada total en DB).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminDeleteTenantResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  async deleteTenant(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Req() req: Request,
  ): Promise<SuperadminDeleteTenantResponseDto> {
    const keyId = req.header('x-kdevs-key-id') ?? 'unknown';
    this.logger.warn({
      event: 'superadmin.tenant.delete',
      companyId,
      keyId,
      message: 'Borrado irreversible de tenant (cascada total) solicitado.',
    });

    await this.deleteTenantAction.execute(companyId);
    return { success: true, deletedCompanyId: companyId };
  }
}
