import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query de `GET /admin/companies` (superadmin). Paginación simple offset/limit
 * + búsqueda por nombre (ILIKE).
 *
 * Multi-tenancy: este endpoint cruza tenants por diseño (el superadmin opera
 * sobre toda la plataforma). El guard `@Roles('superadmin')` lo controla.
 */
export class ListCompaniesQueryDto {
  @ApiPropertyOptional({ example: 'bodegón', description: 'Búsqueda libre en name (ILIKE).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ example: 50, description: 'Tamaño de página (1..200). Default 50.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ example: 0, description: 'Offset (default 0).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
