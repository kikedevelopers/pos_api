import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Cuerpo del POST que genera un respaldo. El panel manda quién pulsó el botón
 * para dejarlo en los metadatos del objeto; el cron no manda nada y el respaldo
 * queda como "Automático".
 *
 * Va dentro del cuerpo FIRMADO, así que llega con la misma garantía que el
 * resto de la petición.
 */
export class CreateBackupDto {
  @ApiPropertyOptional({
    description: 'Nombre del admin que genera el respaldo. Vacío = automático.',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  createdBy?: string;
}
