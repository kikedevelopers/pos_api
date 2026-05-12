import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Payload de `PUT /alert-configs/:type`.
 *
 * El `type` viaja por URL (no en el body). El body trae `enabled`,
 * `threshold` y `config`. El service hace UPSERT — si no existía, crea la
 * row con `type` del URL.
 *
 * `threshold` puede ser null para deshabilitar el umbral (cuando la
 * forma del `config` no lo requiere).
 *
 * `config` es jsonb libre — su forma la valida cada evaluator en Fase 11.
 */
export class UpsertAlertConfigDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    example: 5,
    nullable: true,
    description: 'Umbral genérico (cantidad o porcentaje). Hasta 4 decimales, no negativo.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'threshold debe ser número con hasta 4 decimales' })
  @Min(0)
  @Max(999_999_999_999)
  threshold?: number | null;

  @ApiPropertyOptional({
    type: Object,
    default: {},
    description: 'Parámetros específicos del evaluator. Forma libre — el evaluator decide.',
  })
  @IsOptional()
  @IsObject({ message: 'config debe ser un objeto' })
  config?: Record<string, unknown>;
}

/**
 * Validador de `:type` — string sin espacios, solo caracteres seguros
 * (`[a-z0-9_]+`). Mantiene el namespace acotado.
 */
export class AlertConfigTypeParam {
  @ApiProperty({ example: 'low_stock' })
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'type debe ser snake_case (a-z, 0-9, _), comenzando con letra',
  })
  type!: string;
}
