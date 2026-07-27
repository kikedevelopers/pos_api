import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '@/common/decorators/public.decorator';
import { SuperadminSignatureGuard } from '@/modules/superadmin/guards/superadmin-signature.guard';

import { CreateBackupAction } from './actions/create-backup.action';
import { ManageBackupAction, type BackupDownloadLink } from './actions/manage-backup.action';
import { BackupDto, BackupsListDto, CreatedBackupDto } from './dto/backup.dto';
import { CreateBackupDto } from './dto/create-backup.dto';
import { GcsStorageService } from './gcs-storage.service';

/**
 * Endpoints `/superadmin/backups/*` para el panel kdevs-admin.
 *
 * Protegidos con la firma Ed25519 del par dedicado del panel
 * (`SUPERADMIN_SIGNING_PUBLIC_KEY`), no JWT: son operaciones de infraestructura
 * sobre TODA la base, no de un tenant.
 *
 * Cuelgan de `/superadmin` a propósito, aunque vivan en su propio módulo: el
 * proxy de kdevs-admin solo habla con ese prefijo (defensa deliberada contra
 * confused deputy) y no tiene sentido ampliarle la superficie por esto.
 */
@ApiTags('backups')
@Public()
@UseGuards(SuperadminSignatureGuard)
@Controller('superadmin/backups')
export class BackupsController {
  private readonly logger = new Logger(BackupsController.name);

  constructor(
    private readonly storage: GcsStorageService,
    private readonly createBackupAction: CreateBackupAction,
    private readonly manageBackupAction: ManageBackupAction,
  ) {}

  // --------------------------------------------------------------------------
  // GET /superadmin/backups
  // --------------------------------------------------------------------------

  @Get()
  @ApiOperation({
    summary: 'Listar los respaldos existentes en Google Cloud Storage.',
    description:
      'Devuelve los objetos del bucket configurado, del más reciente al más antiguo. ' +
      '`configured: false` indica que falta GCS_BACKUP_BUCKET (el panel lo muestra sin romperse).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: BackupsListDto })
  async list(): Promise<BackupsListDto> {
    if (!this.storage.isConfigured) {
      return { configured: false, bucket: '', prefix: '', backups: [] };
    }
    const backups = (await this.storage.list()) as BackupDto[];
    return {
      configured: true,
      bucket: this.storage.bucketName,
      prefix: this.storage.prefix,
      backups,
    };
  }

  // --------------------------------------------------------------------------
  // POST /superadmin/backups
  // --------------------------------------------------------------------------

  @Post()
  @ApiOperation({
    summary: 'Generar un respaldo de la base de datos y subirlo al bucket.',
    description:
      'Ejecuta `pg_dump --format=custom` y lo sube EN STREAMING a GCS (no toca disco). ' +
      'El nombre lleva el entorno delante (prod-/dev-) y el autor queda en los metadatos. ' +
      'Responde cuando el archivo ya está en el bucket. 503 si el módulo no está configurado; ' +
      '500 con el error real de pg_dump si el volcado falla (el objeto a medias se elimina).',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: CreatedBackupDto })
  @ApiResponse({ status: HttpStatus.SERVICE_UNAVAILABLE, description: 'Respaldos no configurados' })
  async create(@Body() dto: CreateBackupDto, @Req() req: Request): Promise<CreatedBackupDto> {
    const keyId = req.header('x-kdevs-key-id') ?? 'unknown';
    this.logger.log({ event: 'backups.create.request', keyId, createdBy: dto.createdBy });
    const created = await this.createBackupAction.execute({
      createdBy: dto.createdBy,
      trigger: 'manual',
    });
    return { ...created, trigger: 'manual' };
  }

  // --------------------------------------------------------------------------
  // GET /superadmin/backups/:fileName/download
  // --------------------------------------------------------------------------

  @Get(':fileName/download')
  @ApiOperation({
    summary: 'Enlace firmado para descargar un respaldo.',
    description:
      'Devuelve una URL v4 de Google Storage válida 5 minutos. El archivo viaja directo del ' +
      'bucket al navegador, sin pasar por la API. 400 si el nombre no tiene el formato esperado.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'El respaldo no existe' })
  downloadBackup(@Param('fileName') fileName: string): Promise<BackupDownloadLink> {
    return this.manageBackupAction.downloadUrl(fileName);
  }

  // --------------------------------------------------------------------------
  // DELETE /superadmin/backups/:fileName
  // --------------------------------------------------------------------------

  @Delete(':fileName')
  @ApiOperation({ summary: 'Borrar un respaldo del bucket (irreversible).' })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'El respaldo no existe' })
  deleteBackup(
    @Param('fileName') fileName: string,
    @Req() req: Request,
  ): Promise<{ deleted: string }> {
    const keyId = req.header('x-kdevs-key-id') ?? 'unknown';
    this.logger.warn({ event: 'backups.delete.request', fileName, keyId });
    return this.manageBackupAction.remove(fileName);
  }
}
