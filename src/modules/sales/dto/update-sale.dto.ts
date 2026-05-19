import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Línea del payload de `PUT /sales/:id`. Conserva el shape cloud histórico
 * (`product_id`, `unit_price`, `iva_percentage`, `packaging_id`,
 * `product_price_id`) porque el `UpdateSaleAction` lo usa internamente para
 * recalcular totales y generar NC/ND con precisión.
 *
 * NOTA: el `POST /sales` usa otro shape (espejo PlacePos, ver
 * `CreateSaleLineDto`). No se reutiliza este DTO para el create porque los
 * contratos divergen intencionalmente: el create acepta totales pre-
 * calculados por el cliente, el update recalcula desde cero.
 */
export class UpdateSaleLineDto {
  @ApiProperty({
    example: 1,
    description: 'ID del producto vendido (debe pertenecer a la company).',
  })
  @Type(() => Number)
  @IsInt({ message: 'product_id debe ser entero' })
  @Min(1, { message: 'product_id debe ser >= 1' })
  product_id!: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'ID del empaque aplicado (opcional). Debe pertenecer a la company.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'packaging_id debe ser entero' })
  @Min(1, { message: 'packaging_id debe ser >= 1' })
  packaging_id?: number | null;

  @ApiPropertyOptional({
    example: 3,
    description:
      'ID del nivel de precio aplicado (ProductPrice). Si viene, debe pertenecer al producto.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'product_price_id debe ser entero' })
  @Min(1, { message: 'product_price_id debe ser >= 1' })
  product_price_id?: number | null;

  @ApiPropertyOptional({
    example: 'Aceite Diana 1L',
    description: 'Snapshot opcional del nombre. Si no viene, se toma de product.name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty({ example: 2, description: 'Cantidad vendida. > 0. Hasta 4 decimales.' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'quantity debe ser un número con hasta 4 decimales' },
  )
  @IsPositive({ message: 'quantity debe ser mayor a cero' })
  quantity!: number;

  @ApiProperty({
    example: 25.5,
    description: 'Precio unitario al momento de la venta (snapshot). >= 0.',
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'unit_price debe ser un número con hasta 2 decimales' },
  )
  @Min(0, { message: 'unit_price debe ser >= 0' })
  unit_price!: number;

  @ApiPropertyOptional({
    example: 16,
    description: 'Porcentaje IVA aplicado a esta línea (0-100). Default 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'iva_percentage debe ser un número con hasta 4 decimales' },
  )
  @Min(0, { message: 'iva_percentage debe ser >= 0' })
  iva_percentage?: number;
}

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
    type: [UpdateSaleLineDto],
    description:
      'Snapshot completo de las líneas tras la edición. Si se envía, debe ' +
      'contener al menos una. Si la venta es SALE el delta vs líneas vivas ' +
      'genera NC/ND.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'La venta debe contener al menos una línea' })
  @ValidateNested({ each: true })
  @Type(() => UpdateSaleLineDto)
  lines?: UpdateSaleLineDto[];

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
