import { ApiProperty } from '@nestjs/swagger';

/** Un respaldo almacenado en el bucket. */
export class BackupDto {
  @ApiProperty({ description: 'Ruta completa dentro del bucket' })
  name!: string;

  @ApiProperty({ description: 'Nombre del archivo, sin la carpeta' })
  fileName!: string;

  @ApiProperty({ description: 'Tamaño en bytes' })
  sizeBytes!: number;

  @ApiProperty({ description: 'Fecha de creación (ISO)' })
  createdAt!: string;

  @ApiProperty({ description: 'Content-Type del objeto', nullable: true })
  contentType!: string | null;

  @ApiProperty({ description: 'Quién lo generó; null en respaldos antiguos', nullable: true })
  createdBy!: string | null;

  @ApiProperty({ description: '"manual" o "cron"', nullable: true })
  trigger!: string | null;

  @ApiProperty({ description: 'Entorno donde se generó (prod/dev)', nullable: true })
  environment!: string | null;

  @ApiProperty({ description: 'Versión del PostgreSQL volcado', nullable: true })
  serverVersion!: string | null;

  @ApiProperty({ description: 'Versión de pg_dump que generó el archivo', nullable: true })
  pgDumpVersion!: string | null;
}

/** Listado de respaldos + estado de la configuración. */
export class BackupsListDto {
  @ApiProperty({ description: 'false si falta GCS_BACKUP_BUCKET' })
  configured!: boolean;

  @ApiProperty({ description: 'Bucket destino' })
  bucket!: string;

  @ApiProperty({ description: 'Carpeta dentro del bucket' })
  prefix!: string;

  @ApiProperty({ type: [BackupDto] })
  backups!: BackupDto[];
}

/** Respaldo recién creado. */
export class CreatedBackupDto extends BackupDto {
  @ApiProperty({ description: 'Cuánto tardó el volcado + subida (ms)' })
  durationMs!: number;

  @ApiProperty({ description: 'Respaldos antiguos borrados por retención' })
  prunedCount!: number;
}
