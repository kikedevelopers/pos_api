import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '@/common/decorators/public.decorator';
import { AdminSignatureGuard } from '@/common/guards/admin-signature.guard';

import { MigrationImportDto } from './dto/migration-import.dto';
import { MigrationSummaryDto } from './dto/migration-summary.dto';
import { parseMigrationZip } from './internal/zip-reader';
import { MigrationImportService } from './migration-import.service';

/**
 * Endpoint para importar el ZIP generado por el migrador (kdevs-admin /
 * placepos `cloudMigration/buildZip.ts`). Toma un ZIP + lista de módulos y
 * reconstruye el tenant en este API multi-tenant.
 *
 * Autenticación por FIRMA asimétrica: `@Public()` salta el JWT global y
 * `AdminSignatureGuard` exige una firma Ed25519 válida (clave pública en
 * `ADMIN_SIGNING_PUBLIC_KEY`). Así el panel kdevs-admin lo invoca con su
 * clave privada, igual que el resto de endpoints firmados.
 */
@ApiTags('migration-import')
@Public()
@UseGuards(AdminSignatureGuard)
@Controller('migration-import')
export class MigrationImportController {
  // Límite de tamaño del ZIP: 50 MB. Suficiente para tenants medianos
  // (los dumps reales rondan 5-15 MB comprimidos).
  private static readonly MAX_ZIP_SIZE_BYTES = 50 * 1024 * 1024;

  constructor(private readonly service: MigrationImportService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MigrationImportController.MAX_ZIP_SIZE_BYTES },
    }),
  )
  @ApiOperation({
    summary: 'Importar ZIP de migración altivopos → pos_api cloud',
    description:
      'Multipart form-data. Solo disponible cuando NODE_ENV != "production". ' +
      'Recibe el ZIP generado por placepos `cloudMigration/buildZip.ts` y reconstruye ' +
      'la company multi-tenant. Las dependencias modulares se resuelven automáticamente.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        selectedModules: {
          type: 'string',
          description: 'JSON array de módulos seleccionados',
          example: '["catalog","customers","sales"]',
        },
      },
      required: ['file', 'selectedModules'],
    },
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: MigrationSummaryDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'ZIP inválido o body malformado' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Company o User ya existen en BD',
  })
  async import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: MigrationImportDto,
  ): Promise<MigrationSummaryDto> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        message: 'El campo `file` es obligatorio y no puede estar vacío',
        payload: { code: 'MISSING_FILE' },
      });
    }

    const zip = await parseMigrationZip(file.buffer);
    return this.service.importZip(zip, dto.selectedModules);
  }
}
