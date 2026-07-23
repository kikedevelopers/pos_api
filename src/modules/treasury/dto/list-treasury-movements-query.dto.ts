import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Query params de `GET /treasury/movements`. Feed unificado de TODAS las cuentas
 * de la company (sin filtro por cuenta), acotado por rango.
 *
 * `from`/`to` son instantes ISO opcionales (el cliente calcula el corte del día
 * en zona Colombia). Sin ellos, devuelve todo el historial.
 */
export class ListTreasuryMovementsQueryDto {
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
