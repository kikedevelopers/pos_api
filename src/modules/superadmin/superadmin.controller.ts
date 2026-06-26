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
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '@/common/decorators/public.decorator';

import { UpdateCompanyDto } from '@/modules/companies/dto/update-company.dto';
import { ListOwnersQueryDto } from '@/modules/users/dto/list-owners-query.dto';
import { UpdateMeDto } from '@/modules/users/dto/update-me.dto';

import { CreateTenantAction } from './actions/create-tenant.action';
import { DeleteTenantAction } from './actions/delete-tenant.action';
import { ExportTenantAction } from './actions/export-tenant.action';
import { GetTenantDetailAction } from './actions/get-tenant-detail.action';
import { ImportTenantAction } from './actions/import-tenant.action';
import { ListTenantsAction } from './actions/list-tenants.action';
import { ResetTenantOwnerPasswordAction } from './actions/reset-tenant-owner-password.action';
import { UpdateBranchesAction, type UpdateBranchesResult } from './actions/update-branches.action';
import { UpdateSubscriptionAction } from './actions/update-subscription.action';
import { UpdateTenantCompanyAction } from './actions/update-tenant-company.action';
import { UpdateTenantOwnerAction } from './actions/update-tenant-owner.action';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { ImportTenantDto } from './dto/import-tenant.dto';
import { ResetOwnerPasswordDto } from './dto/reset-owner-password.dto';
import { UpdateBranchesDto } from './dto/update-branches.dto';
import { SuperadminCreateTenantResponseDto } from './dto/superadmin-create-tenant-response.dto';
import { SuperadminDeleteTenantResponseDto } from './dto/superadmin-delete-tenant-response.dto';
import {
  SuperadminTenantCompanyDto,
  SuperadminTenantOwnerDto,
} from './dto/superadmin-tenant-detail.dto';
import {
  SuperadminSubscriptionResponseDto,
  toSuperadminSubscriptionResponseDto,
} from './dto/superadmin-subscription-response.dto';
import { SuperadminTenantDetailDto } from './dto/superadmin-tenant-detail.dto';
import { SuperadminTenantsResponseDto } from './dto/superadmin-tenants-response.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { SuperadminSignatureGuard } from './guards/superadmin-signature.guard';
import type { ImportResult, TenantBackup } from './tenant-backup/tenant-backup.util';

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
    private readonly updateBranchesAction: UpdateBranchesAction,
    private readonly deleteTenantAction: DeleteTenantAction,
    private readonly createTenantAction: CreateTenantAction,
    private readonly updateTenantOwnerAction: UpdateTenantOwnerAction,
    private readonly resetTenantOwnerPasswordAction: ResetTenantOwnerPasswordAction,
    private readonly updateTenantCompanyAction: UpdateTenantCompanyAction,
    private readonly exportTenantAction: ExportTenantAction,
    private readonly importTenantAction: ImportTenantAction,
  ) {}

  // --------------------------------------------------------------------------
  // POST /superadmin/tenants
  // --------------------------------------------------------------------------

  @Post('tenants')
  @ApiOperation({
    summary: 'Crear una cuenta nueva (company + owner + suscripción trial).',
    description:
      'Reutiliza el flujo de registro cloud de placepos: crea atómicamente la ' +
      'company, el owner (argon2id), su membresía, los seeds esenciales y una ' +
      'suscripción trial de 10 días. La cuenta queda lista para iniciar sesión ' +
      'en placepos. Requiere firma superadmin válida. 409 si el email ya existe.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: SuperadminCreateTenantResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Email ya registrado (EMAIL_TAKEN)' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Firma ausente/inválida/expirada' })
  async createTenant(
    @Body() dto: CreateTenantDto,
    @Req() req: Request,
  ): Promise<SuperadminCreateTenantResponseDto> {
    const keyId = req.header('x-kdevs-key-id') ?? 'unknown';
    this.logger.log({
      event: 'superadmin.tenant.create.request',
      keyId,
      ownerEmail: dto.email,
      companyName: dto.company_name,
    });
    return this.createTenantAction.execute(dto);
  }

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
  // PATCH /superadmin/tenants/:companyId/branches
  // --------------------------------------------------------------------------

  @Patch('tenants/:companyId/branches')
  @ApiOperation({
    summary: 'Habilitar/inhabilitar sucursales del tenant y fijar la cantidad permitida.',
    description:
      'Body: { enabled, allowed }. Se aplica sobre el negocio PRINCIPAL del tenant (400 si es ' +
      'una sucursal). enabled ⇒ allowed >= 1. No suspende sucursales: la reconciliación la hace ' +
      'el owner desde su POS.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido o no es principal',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company/owner no existe' })
  updateBranches(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpdateBranchesDto,
  ): Promise<UpdateBranchesResult> {
    return this.updateBranchesAction.execute(companyId, dto);
  }

  // --------------------------------------------------------------------------
  // PATCH /superadmin/tenants/:companyId/owner
  // --------------------------------------------------------------------------

  @Patch('tenants/:companyId/owner')
  @ApiOperation({
    summary: 'Editar el perfil del owner de un tenant (name/lastname/email).',
    description:
      'Reutiliza la lógica de PUT /users/me (update parcial, email a minúsculas). ' +
      '409 si el email ya pertenece a otra cuenta (EMAIL_TAKEN).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminTenantOwnerDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Email ya registrado (EMAIL_TAKEN)' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company/owner no existe' })
  updateTenantOwner(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpdateMeDto,
  ): Promise<SuperadminTenantOwnerDto> {
    return this.updateTenantOwnerAction.execute(companyId, dto);
  }

  // --------------------------------------------------------------------------
  // PATCH /superadmin/tenants/:companyId/owner/password
  // --------------------------------------------------------------------------

  @Patch('tenants/:companyId/owner/password')
  @ApiOperation({
    summary: 'Resetear la contraseña del owner de un tenant (operador, sin contraseña actual).',
    description:
      'Fija una nueva contraseña (argon2id). No pide la contraseña actual: es una ' +
      'operación del operador del panel, no del propio owner.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company/owner no existe' })
  resetTenantOwnerPassword(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: ResetOwnerPasswordDto,
  ): Promise<{ success: boolean }> {
    return this.resetTenantOwnerPasswordAction.execute(companyId, dto);
  }

  // --------------------------------------------------------------------------
  // PATCH /superadmin/tenants/:companyId/company
  // --------------------------------------------------------------------------

  @Patch('tenants/:companyId/company')
  @ApiOperation({
    summary: 'Editar los datos de la company de un tenant.',
    description:
      'Reutiliza la lógica de PUT /companies/:id (update parcial; cadenas vacías en ' +
      'document_number/address/email/phone_number se persisten como null).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminTenantCompanyDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  updateTenantCompany(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpdateCompanyDto,
  ): Promise<SuperadminTenantCompanyDto> {
    return this.updateTenantCompanyAction.execute(companyId, dto);
  }

  // --------------------------------------------------------------------------
  // GET /superadmin/tenants/:companyId/export
  // --------------------------------------------------------------------------

  @Get('tenants/:companyId/export')
  @ApiOperation({
    summary: 'Exportar un respaldo COMPLETO del tenant (snapshot JSON de todas sus tablas).',
    description:
      'Descubre dinámicamente del catálogo TODAS las tablas con scoping por company_id y ' +
      'vuelca sus filas para esta company (más la fila companies). Incluye un hash sha256 de ' +
      'integridad. El panel empaqueta el snapshot en un .zip por tabla.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  exportTenant(@Param('companyId', ParseIntPipe) companyId: number): Promise<TenantBackup> {
    return this.exportTenantAction.execute(companyId);
  }

  // --------------------------------------------------------------------------
  // POST /superadmin/tenants/:companyId/import
  // --------------------------------------------------------------------------

  @Post('tenants/:companyId/import')
  @ApiOperation({
    summary: 'Importar un respaldo: inserta lo que falta, ignora lo que ya existe.',
    description:
      'Valida el hash de integridad (400 si fue alterado) y que el respaldo corresponde a esta ' +
      'company. Inserta en orden topológico con ON CONFLICT DO NOTHING (ids originales): los ' +
      'datos existentes se ignoran y los nuevos se crean. Reporta cuántas filas se insertaron, ' +
      'ignoraron y saltaron.',
  })
  @ApiResponse({ status: HttpStatus.CREATED })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Respaldo inválido, alterado o de otra company',
  })
  importTenant(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: ImportTenantDto,
    @Req() req: Request,
  ): Promise<ImportResult> {
    const keyId = req.header('x-kdevs-key-id') ?? 'unknown';
    this.logger.log({
      event: 'superadmin.tenant.import.request',
      companyId,
      keyId,
      rowCount: dto.meta?.rowCount,
    });
    return this.importTenantAction.execute(companyId, dto as unknown as TenantBackup);
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
