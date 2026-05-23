import { ApiProperty } from '@nestjs/swagger';

/**
 * Resumen del import devuelto por `POST /migration-import`. Se envuelve por
 * `ResponseWrapperInterceptor` en `{ success: true, payload: ... }`.
 */
export class MigrationSummaryDto {
  @ApiProperty({ description: 'ID real (bigint as string) de la Company creada.', example: '42' })
  company_id_real!: string;

  @ApiProperty({ description: 'ID real (bigint as string) del User owner creado.', example: '87' })
  user_id_real!: string;

  @ApiProperty({
    description: 'Conteo de filas insertadas por tabla.',
    example: { products: 120, sale_invoices: 350 },
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  inserted!: Record<string, number>;

  @ApiProperty({
    description: 'Warnings no fatales producidos durante el import.',
    example: ['supplier_id no resoluble en purchase X — fila descartada'],
    type: [String],
  })
  warnings!: string[];

  @ApiProperty({ description: 'Duración total del import en ms.', example: 4231 })
  duration_ms!: number;
}
