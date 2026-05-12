import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

import type { AccountReference } from '../entities/financial-movement.entity';

const ACCOUNT_TYPES = ['bank', 'wallet', 'cash_register', 'external'] as const;

/**
 * Query params de `GET /financial-movements`. Espeja PlacePos:
 *   `?account_type=bank&account_id=1`
 *
 * Ambos requeridos a nivel HTTP (PlacePos devuelve 400 si falta cualquiera);
 * los marcamos `optional` en el DTO para que el ValidationPipe los acepte y
 * el service emita 400 con el mensaje exacto de PlacePos.
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
}
