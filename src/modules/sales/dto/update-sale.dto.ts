import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { CreateSaleLineDto } from './create-sale.dto';

/**
 * Payload de `PUT /sales/:id`. Espejo del `editTicket` de PlacePos.
 *
 * --------------------------------------------------------------------------
 * Casos de uso (según el `ticket_type` actual de la venta)
 * --------------------------------------------------------------------------
 *
 *   - `ORDER`: edición libre. Reemplazo total de líneas + cliente + notas.
 *     NO genera NC/ND. NO toca inventario (las ORDER no consumieron stock).
 *
 *   - `SALE`:
 *     - Solo cambia el cliente (lines ausentes o iguales): UPDATE
 *       `customer_id`/`customer_name` (bloquea si la venta tiene SaleCredit
 *       con `paid_amount > 0`).
 *     - Cambian las líneas: emite NC `PARTIAL_VOID` por las
 *       `removed/reduced`, ND `ADDITION` por las `added/increased`, ajusta
 *       inventario diferencial, y recalcula los totales consolidados de la
 *       cabecera. Si la venta tiene una NC `FULL_VOID` activa la edición
 *       es rechazada (422).
 *
 * El campo `override_margin` lo respeta solo si el actor es owner/superadmin
 * (enforced por `assertMarginAboveMinimum`).
 */
export class UpdateSaleDto {
  @ApiPropertyOptional({
    example: 1,
    description:
      'ID del cliente (debe pertenecer a la company). Para venta mostrador, omitir o enviar null.',
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
    description:
      'Snapshot completo de las líneas tras la edición. Si se envía, debe ' +
      'contener al menos una. Si la venta es SALE el delta vs líneas vivas ' +
      'genera NC/ND.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'La venta debe contener al menos una línea' })
  @ValidateNested({ each: true })
  @Type(() => CreateSaleLineDto)
  lines?: CreateSaleLineDto[];

  @ApiPropertyOptional({
    example: false,
    description:
      'Solicita saltar la validación de margen mínimo. Solo respetado si el ' +
      'actor es owner / superadmin (enforced por `assertMarginAboveMinimum`).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  override_margin?: boolean;
}
