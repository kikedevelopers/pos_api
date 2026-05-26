import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBooleanString, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Query de `GET /delivery-companies`.
 *
 * Contrato Domiciliarios: `search` (substring sobre name) + `include_archived`
 * (default false). Multi-tenancy: siempre filtra por `company_id` del JWT.
 */
export class ListDeliveryCompaniesQueryDto {
  @ApiPropertyOptional({ example: 'rápido', description: 'Substring case-insensitive sobre name.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    example: 'false',
    description: 'Incluir domiciliarios archivados. Default false.',
  })
  @IsOptional()
  @IsBooleanString()
  include_archived?: string;
}
