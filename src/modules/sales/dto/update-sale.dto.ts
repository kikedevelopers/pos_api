import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { preciseNumber } from '@/common/utils/precision';

/**
 * Redondea campos monetarios DERIVADOS (productos de `quantity`) a la escala de
 * su columna ANTES de validar. El cliente los pre-calcula sin redondear
 * (paridad PlacePos); con cantidades fraccionarias superan la escala y
 * `@IsNumber({ maxDecimalPlaces })` rechazaría la edición. Espejo del helper
 * homónimo en `create-sale.dto.ts`. Deja pasar null/undefined/no-numérico.
 */
const roundToScale = (scale: number) =>
  Transform(({ value }) => {
    if (value === null || value === undefined || value === '') {
      return value;
    }
    // Guard: solo redondeamos numéricos finitos; lo demás lo reporta @IsNumber.
    if (!Number.isFinite(Number(value))) {
      return value;
    }
    // `preciseNumber` redondea con Big.js (toBig().round(scale, ROUND_HALF_UP)).
    // Pasamos el valor crudo a Big — sin coerción intermedia a `number`.
    return preciseNumber(value, scale);
  });

/**
 * Tipos de cuenta receptora aceptados como `credit_correction_source` /
 * `debit_correction_source`. Espejo PlacePos `CorrectionSourceType`.
 */
export const SALE_CORRECTION_SOURCE_TYPES = ['bank', 'wallet', 'cash_register'] as const;
export type SaleCorrectionSourceTypeDto = (typeof SALE_CORRECTION_SOURCE_TYPES)[number];

/**
 * Modo en que se asignó el precio a una línea. Espejo PlacePos.
 */
export const UPDATE_SALE_LINE_PRICE_MODES = ['fixed', 'manual'] as const;
export type UpdateSaleLinePriceModeDto = (typeof UPDATE_SALE_LINE_PRICE_MODES)[number];

/**
 * Línea del payload de `PUT /sales/:id`. Espejo byte-por-byte de
 * `SaleInvoiceLinePayload` de PlacePos
 * (`placepos/src/main/database/types.ts`). El cliente PlacePos pre-calcula
 * `cost`, `total`, `profit` y `margin` por línea con Big.js — el service los
 * usa tal cual al persistir / calcular delta (paridad estricta).
 */
export class UpdateSaleLineDto {
  @ApiProperty({
    example: 1,
    description: 'ID del producto vendido (debe pertenecer a la company).',
  })
  @Type(() => Number)
  @IsInt({ message: 'item_id debe ser entero' })
  @Min(1, { message: 'item_id debe ser >= 1' })
  item_id!: number;

  @ApiProperty({
    example: 'Aceite Diana 1L',
    description: 'Snapshot inmutable del nombre del producto al momento de la edición.',
  })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    example: 18.5,
    description: 'Costo unitario al momento de la edición (snapshot). >= 0.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'cost debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'cost debe ser >= 0' })
  cost!: number;

  @ApiProperty({
    example: 25.5,
    description: 'Precio unitario al momento de la edición (snapshot). >= 0.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'price debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'price debe ser >= 0' })
  price!: number;

  @ApiProperty({ example: 2, description: 'Cantidad vendida. > 0. Hasta 4 decimales.' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'quantity debe ser un número con hasta 4 decimales' },
  )
  @IsPositive({ message: 'quantity debe ser mayor a cero' })
  quantity!: number;

  @ApiProperty({
    example: 51,
    description: 'Total de la línea (price * quantity). Pre-calculado por el cliente con Big.js.',
  })
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'total debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'total debe ser >= 0' })
  total!: number;

  @ApiProperty({
    example: 14,
    description: 'Ganancia de la línea ((price - cost) * quantity). Pre-calculada por el cliente.',
  })
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'profit debe ser número con hasta 2 decimales' })
  profit!: number;

  @ApiProperty({
    example: 27.45,
    description: 'Margen porcentual de la línea (profit / total * 100). Hasta 4 decimales.',
  })
  @Type(() => Number)
  @roundToScale(4)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'margin debe ser número con hasta 4 decimales' })
  margin!: number;

  @ApiProperty({
    enum: UPDATE_SALE_LINE_PRICE_MODES,
    example: 'fixed',
    description: 'Cómo se determinó el precio de la línea.',
  })
  @IsString()
  @IsIn([...UPDATE_SALE_LINE_PRICE_MODES], {
    message: 'price_mode inválido. Usa fixed o manual.',
  })
  price_mode!: UpdateSaleLinePriceModeDto;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Índice del nivel de precio usado (0..n-1) cuando `price_mode = fixed`. null si manual.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'price_position debe ser entero' })
  @Min(0, { message: 'price_position debe ser >= 0' })
  price_position?: number | null;

  @ApiPropertyOptional({
    example: 'Sin cebolla, bien cocido.',
    description: 'Nota por línea de venta (una por producto). Opcional. null para limpiar.',
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'note no puede exceder 500 caracteres' })
  note?: string | null;
}

/**
 * Origen de un ajuste (NC/ND) para devoluciones/cargos asociados a una
 * edición. Espejo PlacePos `CorrectionSource`. El front del POS lo envía
 * cuando la edición de una venta SALE genera NC o ND y existe dinero que
 * regresa / entra a una cuenta concreta (bank, wallet o cash_register).
 */
export class SaleCorrectionSourceDto {
  @ApiProperty({
    enum: SALE_CORRECTION_SOURCE_TYPES,
    example: 'cash_register',
    description: 'Tipo de cuenta destino/origen del ajuste.',
  })
  @IsString()
  @IsIn([...SALE_CORRECTION_SOURCE_TYPES], {
    message: 'correction_source.type inválido. Usa bank, wallet o cash_register.',
  })
  type!: SaleCorrectionSourceTypeDto;

  @ApiProperty({
    example: 1,
    description:
      'ID de la cuenta (bank/wallet) o de la cash_register asociada. Multi-tenant: el service valida ownership.',
  })
  @Type(() => Number)
  @IsInt({ message: 'correction_source.id debe ser entero' })
  @Min(1, { message: 'correction_source.id debe ser >= 1' })
  id!: number;

  @ApiProperty({ example: 'Caja registradora principal' })
  @IsString()
  @MaxLength(200)
  name!: string;
}

/**
 * Payload de `PUT /sales/:id`. Espejo byte-por-byte de `SaleInvoicePayload`
 * de PlacePos (`placepos/src/main/database/types.ts`).
 *
 * --------------------------------------------------------------------------
 * Casos de uso (según el `ticket_type` actual de la venta)
 * --------------------------------------------------------------------------
 *
 *   - `ORDER`: edición libre. Reemplazo total de líneas + cliente. NO genera
 *     NC/ND. NO toca inventario (las ORDER no consumieron stock). NO consulta
 *     `*_correction_source`.
 *
 *   - `SALE`:
 *     - Sin cambio de líneas y sin cambio de cliente: no-op.
 *     - Solo cambia el cliente: UPDATE `customer_*` (bloquea si la venta
 *       tiene SaleCredit con `paid_amount > 0`).
 *     - Cambian las líneas: emite NC `PARTIAL_VOID` por removidas/reducidas,
 *       ND `ADDITION` por añadidas/incrementadas, ajusta inventario
 *       diferencial. Si la venta tiene NC `FULL_VOID` activa → 422.
 *       Cuando la NC mueve dinero ↦ se exige `credit_correction_source`;
 *       cuando la ND mueve dinero ↦ se exige `debit_correction_source`.
 *
 * El campo `override_margin` solo lo respeta el guard de margen si el actor
 * es owner/superadmin.
 */
export class UpdateSaleDto {
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
  items?: UpdateSaleLineDto[];

  @ApiPropertyOptional({
    example: 102,
    description: 'Total consolidado de la venta tras la edición. Σ items.total.',
  })
  @IsOptional()
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'total debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'total debe ser >= 0' })
  total?: number;

  @ApiPropertyOptional({
    example: 74,
    description: 'Costo consolidado de la venta tras la edición.',
  })
  @IsOptional()
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'cost debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'cost debe ser >= 0' })
  cost?: number;

  @ApiPropertyOptional({
    example: 28,
    description: 'Ganancia consolidada de la venta tras la edición.',
  })
  @IsOptional()
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'profit debe ser número con hasta 2 decimales' })
  profit?: number;

  @ApiPropertyOptional({
    example: 27.4509,
    description: 'Margen consolidado de la venta tras la edición. Hasta 4 decimales.',
  })
  @IsOptional()
  @Type(() => Number)
  @roundToScale(4)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'margin debe ser número con hasta 4 decimales' })
  margin?: number;

  @ApiPropertyOptional({
    example: 1,
    description:
      'ID del cliente (debe pertenecer a la company). Omitir = no tocar; null = limpiar (venta mostrador).',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'customer_id debe ser entero' })
  @Min(1, { message: 'customer_id debe ser >= 1' })
  customer_id?: number | null;

  @ApiPropertyOptional({
    example: 'Juan Pérez',
    description:
      'Snapshot del nombre del cliente. Si no viene y customer_id está, el service toma `customer.name`.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customer_name?: string | null;

  @ApiPropertyOptional({
    type: SaleCorrectionSourceDto,
    description:
      'Cuenta a la que vuelve el dinero por la NC generada en la edición (solo para ventas SALE con productos removidos/reducidos).',
    nullable: true,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleCorrectionSourceDto)
  credit_correction_source?: SaleCorrectionSourceDto | null;

  @ApiPropertyOptional({
    type: SaleCorrectionSourceDto,
    description:
      'Cuenta desde la que entra el dinero por la ND generada en la edición (solo para ventas SALE con productos añadidos/incrementados).',
    nullable: true,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleCorrectionSourceDto)
  debit_correction_source?: SaleCorrectionSourceDto | null;

  @ApiPropertyOptional({
    example: false,
    description:
      'Solicita saltar la validación de margen mínimo. Solo respetado si el actor es owner / superadmin.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  override_margin?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'Solicita permitir que la edición deje el stock negativo (al añadir/incrementar ' +
      'líneas que generan ND). Solo lo respeta el ajuste de inventario si el actor es ' +
      'owner / superadmin — paridad PlacePos `editSale` (override_stock).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  override_stock?: boolean;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
    description:
      'UUID v4 generado por el cliente para deduplicar reintentos de edición. Aceptado ' +
      'por paridad PlacePos (`client_operation_id`); la idempotencia server-side completa ' +
      'está pendiente (la transacción SERIALIZABLE es el guard de concurrencia actual). ' +
      'El cliente Electron lo genera al abrir el editor y reusa la misma llave en un doble-click.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID(4)
  client_operation_id?: string | null;
}
