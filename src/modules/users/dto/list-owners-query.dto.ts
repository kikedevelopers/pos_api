import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query de `GET /admin/users/owners` (firmado). Paginación offset/limit +
 * búsqueda libre (ILIKE en nombre/apellido/email del owner y nombre de su
 * company). Cruza tenants por diseño — protegido por firma asimétrica.
 */
export class ListOwnersQueryDto {
  @ApiPropertyOptional({ example: 'surtidor', description: 'Búsqueda en owner y company (ILIKE).' })
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
