import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * Payload de `PUT /app-settings/:key`.
 *
 * Acepta `value` libre como string. Para settings que el cliente serializa
 * como JSON (ej. `pos_margins`), el cliente envía el string serializado y
 * el servicio lo almacena tal cual. Esto mantiene la paridad byte-a-byte
 * con PlacePos local (que también almacena strings).
 */
export class UpsertAppSettingDto {
  @ApiProperty({
    example: 'dark',
    maxLength: 10_000,
    description: 'Valor del setting. String libre — para arrays/objetos enviar JSON serializado.',
  })
  @IsString()
  @MaxLength(10_000)
  value!: string;
}
