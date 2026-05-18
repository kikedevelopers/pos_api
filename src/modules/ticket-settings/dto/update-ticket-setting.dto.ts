import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';

/**
 * Payload de `PUT /ticket-settings/:id`.
 *
 * Solo permite modificar `prefix`/`suffix`. `current_number` cambia
 * exclusivamente vía incremento atómico al crear ventas/compras/notas; el
 * cliente NO puede setearlo desde la API (sería un vector para producir
 * folios duplicados).
 *
 * Reglas paridad PlacePos para `prefix`:
 *   - 2-32 caracteres.
 *   - Solo mayúsculas A-Z, dígitos 0-9 y guión medio `-`.
 *   - No puede empezar ni terminar en `-`.
 *   - No puede contener `--` consecutivos.
 *
 * `suffix` mantiene su validación laxa (texto libre hasta 20 chars).
 */
export class UpdateTicketSettingDto {
  @ApiPropertyOptional({
    example: 'F',
    minLength: 2,
    maxLength: 32,
    nullable: true,
    description:
      'Prefijo del folio (ej. "F" → "F-001"). 2-32 chars, [A-Z0-9-], sin `--` ni `-` en bordes. null o "" = sin prefijo.',
  })
  @IsOptional()
  // `null` o "" significan "sin prefix" — saltan las reglas de formato.
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsString()
  @Length(2, 32, { message: 'prefix debe tener entre 2 y 32 caracteres' })
  @Matches(/^[A-Z0-9-]+$/, {
    message: 'prefix solo permite mayúsculas A-Z, dígitos 0-9 y guión medio',
  })
  @Matches(/^(?!-)(?!.*--)(?!.*-$).+$/, {
    message: 'prefix no puede empezar o terminar en `-` ni contener `--`',
  })
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
