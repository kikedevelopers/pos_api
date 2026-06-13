import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';

import type { AccountReference } from '../entities/financial-movement.entity';

const ACCOUNT_TYPES = ['bank', 'wallet', 'cash_register', 'external'] as const;

/**
 * Query params de `GET /financial-movements`. Espeja PlacePos:
 *   `?account_type=bank&account_id=1&from=&to=`
 *
 * Ambos requeridos a nivel HTTP (PlacePos devuelve 400 si falta cualquiera);
 * los marcamos `optional` en el DTO para que el ValidationPipe los acepte y
 * el service emita 400 con el mensaje exacto de PlacePos.
 *
 * `from`/`to` son instantes ISO opcionales (el cliente calcula el corte del
 * día en zona Colombia). Sin ellos, devuelve todo el historial de la cuenta.
 */
export class ListFinancialMovementsQueryDto {
  @ApiProperty({ enum: ACCOUNT_TYPES, example: 'bank' })
  @IsOptional()
  @IsString()
  @IsIn([...ACCOUNT_TYPES])
  account_type?: AccountReference;

  @ApiProperty({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  account_id?: number;

  @ApiPropertyOptional({
    example: '2026-06-13T05:00:00.000Z',
    description: 'Instante ISO inicial del rango (inclusive).',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-06-14T04:59:59.999Z',
    description: 'Instante ISO final del rango (inclusive).',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
