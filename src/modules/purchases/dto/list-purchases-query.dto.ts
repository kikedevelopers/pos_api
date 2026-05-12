import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Query de `GET /purchases?showAll=true`. Espejo PlacePos: por defecto se
 * listan solo compras con saldo pendiente; con `showAll=true` se devuelve
 * todo el histórico no anulado.
 */
export class ListPurchasesQueryDto {
  @ApiPropertyOptional({
    description:
      'Si true devuelve todas las compras no anuladas. Si false (default) solo las que tienen balance > 0 en su PurchaseCredit.',
    example: false,
  })
  @IsOptional()
  // Transformación explícita: `?showAll=true` llega como string. Cualquier otro
  // valor (incluido ausencia) se trata como false — paridad PlacePos.
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  showAll?: boolean;
}
