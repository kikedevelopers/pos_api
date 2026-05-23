import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Payload de `PUT /alert-configs/:type`.
 *
 * Espejo PlacePos `AlertConfigUpdatePayload`:
 *   { is_enabled: boolean; check_time: 'HH:mm:ss'; params: Record<string, unknown> }
 *
 * El service combina `check_time` con `params` y los persiste juntos dentro
 * del jsonb `config` de la tabla `alert_configs` para preservar el shape
 * cloud-multi-tenant sin migrar columna por columna.
 */
export class UpsertAlertConfigDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  is_enabled!: boolean;

  @ApiProperty({
    example: '07:00:00',
    description:
      'Hora local de disparo del scheduler en formato HH:mm:ss (24h). Validamos el shape para evitar persistir strings que luego rompan el scheduler.',
  })
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, {
    message: 'check_time debe ser HH:mm:ss (24h)',
  })
  check_time!: string;

  @ApiProperty({
    type: Object,
    description:
      'Parámetros específicos del evaluator. Forma libre — el evaluator decide. NO incluir `check_time` aquí.',
    example: { inactivity_days: 15, min_purchases: 3, recurrence_window_days: 60 },
  })
  @IsObject({ message: 'params debe ser un objeto' })
  params!: Record<string, unknown>;
}

/**
 * Validador de `:type` — string sin espacios, solo caracteres seguros.
 * Acepta UPPER_SNAKE_CASE y lower_snake_case porque placepos usa
 * `INACTIVE_CUSTOMER` en uppercase y el contrato debe ser cross-compatible.
 */
export class AlertConfigTypeParam {
  @ApiProperty({ example: 'INACTIVE_CUSTOMER' })
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]*$/, {
    message: 'type debe ser letras/dígitos/guion bajo, comenzando con letra',
  })
  type!: string;
}
