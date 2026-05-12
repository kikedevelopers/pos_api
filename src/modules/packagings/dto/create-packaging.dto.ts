import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Payload de `POST /packagings`.
 *
 * Paridad PlacePos (`packagings.routes.ts`): el shape es `{ name, value }`.
 * El cliente NO envía `company_id`, `created_by`, `created_by_id`: el
 * service los resuelve desde `req.user` (multi-tenant).
 *
 * Notas:
 *   - `value` se valida como número con hasta 4 decimales (§2.5 CLAUDE.md).
 *     El `ValidationPipe` global tiene `transform: true`, así que un body
 *     JSON con `"value": 12.5` llega como `number`. Validamos rango y
 *     decimales con `maxDecimalPlaces: 4`.
 *   - El service hace `name.trim()` antes de persistir (espejo de PlacePos).
 */
export class CreatePackagingDto {
  @ApiProperty({ example: 'Caja x 12', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    example: 12,
    description:
      'Cantidad de unidades dentro del empaque. numeric(15,4) — admite hasta 4 decimales.',
  })
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 },
    { message: 'value debe ser un número con hasta 4 decimales' },
  )
  @Min(0, { message: 'value debe ser >= 0' })
  value!: number;
}
