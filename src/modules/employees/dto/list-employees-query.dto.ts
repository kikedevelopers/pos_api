import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Query string de `GET /employees`.
 *
 * `includeArchived` controla si el listado incluye empleados archivados
 * (`is_archived = true`). Por defecto (ausente o `false`) el listado devuelve
 * SOLO activos — comportamiento histórico y paridad con PlacePos.
 *
 * El valor llega como string en el query (`?includeArchived=true`); el
 * `@Transform` lo normaliza a boolean para que `@IsBoolean` valide. Se aceptan
 * `'true'`/`'1'` como verdadero; cualquier otra cosa (incluida la ausencia) es
 * falso.
 */
export class ListEmployeesQueryDto {
  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Si es `true`, incluye empleados archivados en el listado. Por defecto solo devuelve activos.',
  })
  @IsOptional()
  @Transform(({ value }): boolean => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeArchived: boolean = false;
}
