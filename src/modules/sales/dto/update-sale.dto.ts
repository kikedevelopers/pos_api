import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { CreateSaleLineDto } from './create-sale.dto';

/**
 * Payload de `PUT /sales/:id`. Solo aplica a ORDER sin pagos.
 *
 * Permite reemplazar customer, notas y líneas. NO permite cambiar
 * `ticket_type` (eso se hace vía `POST /sales/:id/convert`).
 */
export class UpdateSaleDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'ID del cliente (debe pertenecer a la company). Omitir para venta mostrador.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'customer_id debe ser entero' })
  @Min(1, { message: 'customer_id debe ser >= 1' })
  customer_id?: number | null;

  @ApiPropertyOptional({ example: 'Pedido editado.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional({
    type: [CreateSaleLineDto],
    description: 'Reemplazo completo de líneas. Si se envía, debe contener al menos una.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'La venta debe contener al menos una línea' })
  @ValidateNested({ each: true })
  @Type(() => CreateSaleLineDto)
  lines?: CreateSaleLineDto[];
}
