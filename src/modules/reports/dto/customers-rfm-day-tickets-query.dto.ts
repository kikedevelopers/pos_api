import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Min } from 'class-validator';

/**
 * Query de `GET /reports/customers-rfm/day-tickets?customerId=&date=`.
 *
 * Espejo PlacePos `reports.routes.ts:872`. Drill-down del bucket diario de
 * un cliente del reporte RFM hacia los tickets concretos de ese día. Ambos
 * parámetros son OBLIGATORIOS (PlacePos devuelve 400 si falta cualquiera).
 */
export class CustomersRfmDayTicketsQueryDto {
  @ApiProperty({ example: 42, description: 'ID entero del cliente.' })
  @Type(() => Number)
  @IsInt({ message: 'customerId inválido' })
  @Min(1, { message: 'customerId inválido' })
  customerId!: number;

  @ApiProperty({ example: '2026-05-18' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date inválida (YYYY-MM-DD)' })
  date!: string;
}
