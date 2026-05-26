import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { MigrationSummaryDto } from '@/modules/migration-import/dto/migration-summary.dto';

import { RestoreBackupAction } from './actions/restore-backup.action';

/**
 * Endpoint para que un OWNER autenticado restaure un backup NATIVO de placepos
 * sobre SU PROPIA empresa (`company_id` del JWT).
 *
 * Seguridad:
 *   - `JwtAuthGuard` global exige token válido (poblando `request.user`).
 *   - `@Roles('owner')`: operación destructiva (reemplaza los datos de negocio
 *     de la empresa). Solo el owner puede dispararla.
 *   - `SubscriptionGuard` global SÍ aplica (no se exime): un tenant con la
 *     suscripción vencida no puede restaurar.
 *   - NO usa `AdminSignatureGuard` ni `@Public()`: es un endpoint de tenant,
 *     no del panel admin. El import admin (`/migration-import`) queda intacto.
 *
 * El `company_id`/owner provienen del JWT; `companies.json`/`users.json` del
 * ZIP se ignoran. Solo se reemplazan los datos hijos del tenant.
 */
@ApiTags('backup')
@ApiBearerAuth('bearer')
@Controller('backup')
@Roles('owner')
export class BackupRestoreController {
  // Límite de tamaño del ZIP: 50 MB (paridad con el import admin).
  private static readonly MAX_ZIP_SIZE_BYTES = 50 * 1024 * 1024;

  constructor(private readonly restoreBackupAction: RestoreBackupAction) {}

  @Post('restore')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: BackupRestoreController.MAX_ZIP_SIZE_BYTES },
    }),
  )
  @ApiOperation({
    summary: 'Restaurar backup nativo de placepos sobre la propia empresa',
    description:
      'Multipart form-data. Recibe el ZIP de backup NATIVO generado por placepos ' +
      'y reemplaza los datos de negocio (catálogo, clientes, proveedores, empleados, ' +
      'ventas, compras, gastos) de la empresa del JWT. Operación destructiva: solo ' +
      'owner. Conserva la identidad de la empresa (id, nombre, owner).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: MigrationSummaryDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'ZIP inválido o archivo ausente' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  async restore(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<MigrationSummaryDto> {
    return this.restoreBackupAction.execute(file?.buffer, companyId, user);
  }
}
