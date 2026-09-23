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

import { ClearTenantCustomersAction } from './actions/clear-tenant-customers.action';
import { ClearTenantInventoryAction } from './actions/clear-tenant-inventory.action';
import { CreateTenantAction } from './actions/create-tenant.action';
import { DeleteTenantAction } from './actions/delete-tenant.action';
import { ExportTenantAction } from './actions/export-tenant.action';
import { GetTenantCustomersAction } from './actions/get-tenant-customers.action';
import { GetTenantDetailAction } from './actions/get-tenant-detail.action';
import { GetTenantInventoryAction } from './actions/get-tenant-inventory.action';
import { ImportTenantAction } from './actions/import-tenant.action';
import { ListTenantsAction } from './actions/list-tenants.action';
import { ResendActivationAction } from './actions/resend-activation.action';
import { ResetTenantOwnerPasswordAction } from './actions/reset-tenant-owner-password.action';
import {
  UpdateActivationAction,
  type UpdateActivationResult,
} from './actions/update-activation.action';
import { UpdateBranchesAction, type UpdateBranchesResult } from './actions/update-branches.action';
import {
  UpdateElectronicBillingAction,
  type UpdateElectronicBillingResult,
} from './actions/update-electronic-billing.action';
import { UpdateSubscriptionAction } from './actions/update-subscription.action';
import { UpdateTenantCompanyAction } from './actions/update-tenant-company.action';
import { UpdateTenantOwnerAction } from './actions/update-tenant-owner.action';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { ImportTenantDto } from './dto/import-tenant.dto';
import { ResetOwnerPasswordDto } from './dto/reset-owner-password.dto';
import { UpdateActivationDto } from './dto/update-activation.dto';
import { UpdateBranchesDto } from './dto/update-branches.dto';
import { UpdateElectronicBillingDto } from './dto/update-electronic-billing.dto';
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
import {
  SuperadminClearInventoryResponseDto,
  SuperadminTenantInventoryDto,
  toSuperadminClearInventoryResponseDto,
  toSuperadminTenantInventoryDto,
} from './dto/superadmin-tenant-inventory.dto';
import {
  SuperadminClearCustomersResponseDto,
  SuperadminTenantCustomersDto,
  toSuperadminClearCustomersResponseDto,
  toSuperadminTenantCustomersDto,
} from './dto/superadmin-tenant-customers.dto';
import { SuperadminResendActivationResponseDto } from './dto/superadmin-resend-activation-response.dto';
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
    private readonly updateElectronicBillingAction: UpdateElectronicBillingAction,
    private readonly deleteTenantAction: DeleteTenantAction,
    private readonly createTenantAction: CreateTenantAction,
    private readonly updateTenantOwnerAction: UpdateTenantOwnerAction,
    private readonly resetTenantOwnerPasswordAction: ResetTenantOwnerPasswordAction,
    private readonly resendActivationAction: ResendActivationAction,
    private readonly updateActivationAction: UpdateActivationAction,
    private readonly updateTenantCompanyAction: UpdateTenantCompanyAction,
    private readonly exportTenantAction: ExportTenantAction,
    private readonly importTenantAction: ImportTenantAction,
    private readonly getTenantInventoryAction: GetTenantInventoryAction,
    private readonly clearTenantInventoryAction: ClearTenantInventoryAction,
    private readonly getTenantCustomersAction: GetTenantCustomersAction,
    private readonly clearTenantCustomersAction: ClearTenantCustomersAction,
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
    summary: 'Listar TODOS los tenants (owners + company + sucursales) cross-tenant.',
    description:
      'Requiere firma superadmin válida (x-kdevs-signature/timestamp/key-id). ' +
      'Paginación limit/offset y búsqueda libre por owner y company (ILIKE). ' +
      'Incluye por tenant la vigencia de la suscripción (LEFT JOIN; puede ser null). ' +
      'Cada SUCURSAL del owner viaja como una fila más (isBranch=true) inmediatamente ' +
      'después de su negocio principal, de más antigua a más nueva: `tenants` puede ' +
      'traer más filas que `limit`, que pagina CUENTAS principales (`total`). La ' +
      'búsqueda es de grupo: el nombre de una sucursal también trae a su principal.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminTenantsResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Firma ausente/inválida/expirada' })
  async listTenants(@Query() query: ListOwnersQueryDto): Promise<SuperadminTenantsResponseDto> {
    const result = await this.listTenantsAction.execute(query);
    return {
      tenants: result.tenants,
      total: result.total,
      branchCount: result.branchCount,
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
  // PATCH /superadmin/tenants/:companyId/electronic-billing
  // --------------------------------------------------------------------------

  @Patch('tenants/:companyId/electronic-billing')
  @ApiOperation({
    summary: 'Activar/desactivar la Facturación Electrónica del negocio.',
    description:
      'Body: { enabled }. Se aplica sobre el negocio PRINCIPAL del tenant (400 si es una ' +
      'sucursal). Solo mueve el interruptor: TODO el proceso de FE (armado, firma y envío a la ' +
      'DIAN) lo ejecuta el API externo de Laravel (APIDIAN).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido o no es principal',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  updateElectronicBilling(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpdateElectronicBillingDto,
  ): Promise<UpdateElectronicBillingResult> {
    return this.updateElectronicBillingAction.execute(companyId, dto);
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
  // POST /superadmin/tenants/:companyId/resend-activation
  // --------------------------------------------------------------------------

  @Post('tenants/:companyId/resend-activation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reenviar el correo de activación al dueño de un tenant.',
    description:
      'Emite un enlace nuevo (invalidando el anterior) y reenvía el correo de ' +
      'bienvenida. A diferencia del resto de correos del sistema, este espera ' +
      'el envío y falla si el proveedor lo rechaza: el operador necesita saber ' +
      'si el correo salió de verdad.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminResendActivationResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company/owner no existe' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'La cuenta ya está activada, o el correo no pudo salir',
  })
  resendActivation(
    @Param('companyId', ParseIntPipe) companyId: number,
  ): Promise<SuperadminResendActivationResponseDto> {
    return this.resendActivationAction.execute(companyId);
  }

  // --------------------------------------------------------------------------
  // PATCH /superadmin/tenants/:companyId/activation
  // --------------------------------------------------------------------------

  @Patch('tenants/:companyId/activation')
  @ApiOperation({
    summary: 'Activar/desactivar MANUALMENTE la cuenta del owner de un tenant.',
    description:
      'Body: { active }. Setea (o limpia) `users.activated_at` del owner sin enviar ' +
      'ningún correo. active=false revierte la cuenta a "sin activar", lo que vuelve a ' +
      'BLOQUEAR el inicio de sesión del dueño. Se aplica sobre el owner (404 si la ' +
      'company no tiene owner, p. ej. una sucursal).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company/owner no existe' })
  updateActivation(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpdateActivationDto,
  ): Promise<UpdateActivationResult> {
    return this.updateActivationAction.execute(companyId, dto);
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
    summary: 'Importar un respaldo REEMPLAZANDO la data del destino (cross-company).',
    description:
      'Valida el hash de integridad (400 si fue alterado). El respaldo PUEDE ser de otra empresa: ' +
      'se limpia toda la data de negocio del destino y se reemplaza con la del origen, remapeando ' +
      'ids (nuevos, sin colisión), company_id → destino y las referencias de usuario al owner del ' +
      'destino. Se conservan identidad/acceso/config del destino (owner, empleados, roles, ' +
      'suscripción, settings). Reporta cuántas filas se borraron, insertaron y saltaron.',
  })
  @ApiResponse({ status: HttpStatus.CREATED })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Respaldo inválido/alterado o company destino inexistente',
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
  // GET /superadmin/tenants/:companyId/inventory
  // --------------------------------------------------------------------------

  @Get('tenants/:companyId/inventory')
  @ApiOperation({
    summary:
      'Resumen del inventario del tenant (cuántos productos tiene y qué pasaría al vaciarlo).',
    description:
      'Solo lectura. Devuelve productos activos, bases/presentaciones, archivados, valor a costo y ' +
      'el reparto entre los que se BORRARÍAN y los que se ARCHIVARÍAN si se vacía el inventario.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminTenantInventoryDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  async getTenantInventory(
    @Param('companyId', ParseIntPipe) companyId: number,
  ): Promise<SuperadminTenantInventoryDto> {
    return toSuperadminTenantInventoryDto(await this.getTenantInventoryAction.execute(companyId));
  }

  // --------------------------------------------------------------------------
  // DELETE /superadmin/tenants/:companyId/inventory
  // --------------------------------------------------------------------------

  @Delete('tenants/:companyId/inventory')
  @ApiOperation({
    summary: 'Vaciar el inventario del tenant (irreversible en su parte destructiva).',
    description:
      'Los productos SIN historial de negocio se borran; los que tienen ventas, compras, notas o ' +
      'movimientos —o pertenecen a un árbol que los tiene— se archivan para no romper el histórico. ' +
      'En ambos casos el inventario del cliente queda en cero. Categorías y empaques no se tocan.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminClearInventoryResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  async clearTenantInventory(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Req() req: Request,
  ): Promise<SuperadminClearInventoryResponseDto> {
    const keyId = req.header('x-kdevs-key-id') ?? 'unknown';
    this.logger.warn({
      event: 'superadmin.tenant.inventory.clear',
      companyId,
      keyId,
      message: 'Vaciado de inventario solicitado (borra productos sin historial).',
    });
    return toSuperadminClearInventoryResponseDto(
      await this.clearTenantInventoryAction.execute(companyId),
    );
  }

  // --------------------------------------------------------------------------
  // GET /superadmin/tenants/:companyId/customers
  // --------------------------------------------------------------------------

  @Get('tenants/:companyId/customers')
  @ApiOperation({
    summary:
      'Resumen de los clientes del tenant (cuántos tiene y qué pasaría al vaciar la lista).',
    description:
      'Solo lectura. Devuelve clientes activos, archivados y el reparto entre los que se ' +
      'BORRARÍAN (sin historial) y los que se ARCHIVARÍAN (tienen ventas, créditos, notas o ' +
      'anticipos) si se vacía la lista de clientes.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminTenantCustomersDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  async getTenantCustomers(
    @Param('companyId', ParseIntPipe) companyId: number,
  ): Promise<SuperadminTenantCustomersDto> {
    return toSuperadminTenantCustomersDto(await this.getTenantCustomersAction.execute(companyId));
  }

  // --------------------------------------------------------------------------
  // DELETE /superadmin/tenants/:companyId/customers
  // --------------------------------------------------------------------------

  @Delete('tenants/:companyId/customers')
  @ApiOperation({
    summary: 'Vaciar la lista de clientes del tenant (irreversible en su parte destructiva).',
    description:
      'Los clientes SIN historial de negocio se borran; los que tienen ventas, créditos, notas ' +
      'o anticipos se archivan para no romper el histórico. En ambos casos la lista del cliente ' +
      'queda en cero. Ventas, créditos, notas y anticipos no se tocan.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SuperadminClearCustomersResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  async clearTenantCustomers(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Req() req: Request,
  ): Promise<SuperadminClearCustomersResponseDto> {
    const keyId = req.header('x-kdevs-key-id') ?? 'unknown';
    this.logger.warn({
      event: 'superadmin.tenant.customers.clear',
      companyId,
      keyId,
      message: 'Vaciado de clientes solicitado (borra clientes sin historial).',
    });
    return toSuperadminClearCustomersResponseDto(
      await this.clearTenantCustomersAction.execute(companyId),
    );
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
