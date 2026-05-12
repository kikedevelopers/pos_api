import { Controller, Get, HttpStatus, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { BackupService } from './backup.service';

/**
 * Endpoints de backup. Espejo del contrato PlacePos (`backup.routes.ts`).
 *
 * En modo CLOUD la operación de backup vive del lado del proveedor; estos
 * endpoints existen únicamente para preservar paridad con el servidor
 * Express local. Todos responden 503 con `code: BACKUP_NOT_AVAILABLE_IN_CLOUD`.
 *
 * Autorización: `owner | superadmin` — mismo gate que `isPrivilegedUser`
 * de PlacePos. NO usamos `@CurrentCompany()` porque rechaza superadmin
 * (company_id null) y aquí el filtro multi-tenant es irrelevante: nunca se
 * ejecuta una query. Pasamos el `AuthUser` directo al service para logging.
 */
@ApiTags('backup')
@ApiBearerAuth('bearer')
@Controller('backup')
@Roles('owner', 'superadmin')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar backups (no disponible en cloud)',
    description:
      'Stub que preserva el contrato HTTP de PlacePos local. En modo cloud devuelve 503 con `code: BACKUP_NOT_AVAILABLE_IN_CLOUD`.',
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Rol distinto a owner o superadmin',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Backup local no disponible en modo cloud',
  })
  list(@CurrentUser() user: AuthUser): never {
    this.backupService.throwUnavailable('GET /backup', {
      userId: user.user_id,
      companyId: user.company_id,
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Generar backup ZIP (no disponible en cloud)',
    description:
      'Stub que preserva el contrato HTTP de PlacePos local. En modo cloud devuelve 503 con `code: BACKUP_NOT_AVAILABLE_IN_CLOUD`.',
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Rol distinto a owner o superadmin',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Backup local no disponible en modo cloud',
  })
  create(@CurrentUser() user: AuthUser): never {
    this.backupService.throwUnavailable('POST /backup', {
      userId: user.user_id,
      companyId: user.company_id,
    });
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Descargar backup ZIP por id (no disponible en cloud)',
    description:
      'Stub que preserva el contrato HTTP de PlacePos local. En modo cloud devuelve 503 con `code: BACKUP_NOT_AVAILABLE_IN_CLOUD`.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Rol distinto a owner o superadmin',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Backup local no disponible en modo cloud',
  })
  download(
    // `ParseIntPipe` mantiene la validación de contrato (PlacePos rechaza
    // `id <= 0` con 400). Aunque luego ignoramos el valor, validamos shape
    // para que el cliente vea 400 ante un ID malformado, no 503.
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): never {
    this.backupService.throwUnavailable(`GET /backup/${id}/download`, {
      userId: user.user_id,
      companyId: user.company_id,
    });
  }
}
