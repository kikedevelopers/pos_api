import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '@/common/decorators/public.decorator';
import { AdminSignatureGuard } from '@/common/guards/admin-signature.guard';

import { ListOwnersAction } from './actions/list-owners.action';
import { AdminListOwnersResponseDto } from './dto/admin-list-owners-response.dto';
import { toAdminOwnerResponseDto } from './dto/admin-owner-response.dto';
import { ListOwnersQueryDto } from './dto/list-owners-query.dto';

/**
 * Endpoints `/admin/users/*` para paneles externos (kdevs-admin).
 *
 * Autenticación por FIRMA asimétrica (no JWT/rol): `@Public()` salta el
 * `JwtAuthGuard` global y `AdminSignatureGuard` exige una firma Ed25519 válida
 * (clave pública en `ADMIN_SIGNING_PUBLIC_KEY`). Así el panel —y futuras apps—
 * se autentican con su clave privada sin manejar credenciales de superadmin.
 */
@ApiTags('admin')
@Public()
@UseGuards(AdminSignatureGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly listOwnersAction: ListOwnersAction) {}

  // --------------------------------------------------------------------------
  // GET /admin/users/owners
  // --------------------------------------------------------------------------

  @Get('owners')
  @ApiOperation({
    summary: 'Listar TODOS los owners con su company principal (cross-tenant).',
    description:
      'Requiere firma asimétrica válida (headers x-kdevs-signature/timestamp/key-id). ' +
      'Paginación limit/offset y búsqueda libre por owner y company (ILIKE).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AdminListOwnersResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Firma ausente/inválida/expirada' })
  async listOwners(@Query() query: ListOwnersQueryDto): Promise<AdminListOwnersResponseDto> {
    const result = await this.listOwnersAction.execute(query);
    return {
      owners: result.owners.map(toAdminOwnerResponseDto),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }
}
