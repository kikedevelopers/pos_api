import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsNumber, Max, Min } from 'class-validator';

/**
 * Configuración de márgenes del POS — espejo del shape PlacePos
 * (`renderer/src/api/requests/app-settings/types.ts → PosMarginsConfig`).
 *
 * `margins`: array de 0–3 porcentajes en orden ascendente estricto. Si
 * `enabled === false`, el cliente puede leerlos pero la venta no enforza
 * el mínimo.
 */
export class PosMarginsConfigDto {
  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({ example: [15, 25, 40], type: [Number] })
  margins!: number[];
}

/**
 * Payload de `PUT /app-settings/pos-margins`. Validación espejo de
 * `placepos/src/main/server/routes/app-settings.routes.ts`.
 *
 * Reglas:
 *   - `enabled` boolean.
 *   - `margins` array de 0–3 números positivos ≤ 99.99.
 *   - Si `enabled=true`, debe haber al menos 1 margen.
 *   - Los márgenes deben ir en orden ascendente estricto.
 *
 * Las reglas cruzadas (ascendente + non-empty si enabled) se enforzan en
 * el action — class-validator no expresa esa relación con un solo decorator.
 */
export class UpdatePosMarginsDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({
    example: [15, 25, 40],
    type: [Number],
    description:
      'Hasta 3 márgenes positivos, ≤ 99.99, en orden ascendente estricto. Vacío si `enabled=false`.',
  })
  @IsArray()
  @ArrayMaxSize(3)
  @IsNumber({ maxDecimalPlaces: 2 }, { each: true })
  @Min(0.01, { each: true })
  @Max(99.99, { each: true })
  @Type(() => Number)
  margins!: number[];
}
