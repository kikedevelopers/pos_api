import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsInt } from 'class-validator';

/**
 * Payload de `PUT /branches/active`. El owner elige qué sucursales conservar
 * activas (las demás quedan suspendidas) cuando el admin reduce el límite o al
 * reconciliar. El negocio principal NO se incluye (siempre activo).
 */
export class SetActiveBranchesDto {
  @ApiProperty({ example: [12, 15], description: 'IDs de las sucursales a mantener activas.' })
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  active_company_ids!: number[];
}
