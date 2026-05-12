import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload de `PUT /ticket-settings/:ticket_type`.
 *
 * Solo permite modificar `prefix`/`suffix`. `current_number` cambia
 * exclusivamente vía incremento atómico al crear ventas/compras/notas; el
 * cliente NO puede setearlo desde la API (sería un vector para producir
 * folios duplicados).
 *
 * Ambos campos opcionales — el cliente puede pasar solo uno. Cadena vacía
 * se normaliza a `null` en el action (sin prefijo/sufijo).
 */
export class UpdateTicketSettingDto {
  @ApiPropertyOptional({
    example: 'F',
    maxLength: 20,
    nullable: true,
    description: 'Prefijo del folio (ej. "F" → "F-001"). null o "" = sin prefijo.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  prefix?: string | null;

  @ApiPropertyOptional({
    example: 'A',
    maxLength: 20,
    nullable: true,
    description: 'Sufijo del folio (ej. "A" → "001-A"). null o "" = sin sufijo.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  suffix?: string | null;
}
