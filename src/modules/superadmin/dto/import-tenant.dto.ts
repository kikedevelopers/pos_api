import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsObject, IsString } from 'class-validator';

import type { BackupRow } from '../tenant-backup/tenant-backup.util';

/**
 * Body de `POST /superadmin/tenants/:companyId/import`: el snapshot JSON que el
 * panel reconstruye desde el `.zip`. Solo se validan los campos de primer nivel
 * (el `ValidationPipe` global es whitelist + forbidNonWhitelisted); el contenido
 * de `meta`/`tables` lo valida a fondo `ImportTenantAction` (formato, versión y
 * hash de integridad).
 */
export class ImportTenantDto {
  @ApiProperty({ example: 'kdevs-tenant-backup' })
  @IsString()
  format!: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  version!: number;

  @ApiProperty({
    description: 'Metadatos del respaldo: companyId, companyName, generatedAt, hash, conteos.',
  })
  @IsObject()
  meta!: {
    companyId: number;
    companyName: string;
    generatedAt: string;
    tableCount: number;
    rowCount: number;
    hash: string;
  };

  @ApiProperty({ description: 'Mapa tabla → filas (columnas implícitas en cada fila).' })
  @IsObject()
  tables!: Record<string, BackupRow[]>;
}
