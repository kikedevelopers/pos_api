import { ApiProperty } from '@nestjs/swagger';

import { CompanyResponseDto } from './company-response.dto';

/**
 * Respuesta paginada de `GET /admin/companies` (superadmin). El shape sigue
 * el patrón usado por `GET /expenses` y otros listados: `{ companies, total,
 * limit, offset }` para que el frontend pueda paginar.
 */
export class AdminListCompaniesResponseDto {
  @ApiProperty({ type: [CompanyResponseDto] })
  companies!: CompanyResponseDto[];

  @ApiProperty({ example: 42, description: 'Total de companies que matchean (sin paginar).' })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
