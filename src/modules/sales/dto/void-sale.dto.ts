import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

import { SaleCorrectionSourceDto } from './update-sale.dto';

/**
 * Payload de `POST /sales/:id/void`. Espejo PlacePos `voidTicket`.
 *
 * `reason`: texto libre que se persiste en la nota crédito generada.
 *
 * `refund_source`: cuenta destino del reembolso cuando la venta tenía
 * pagos TRANSFER (bank/wallet). Si no se envía y la venta tiene pagos
 * TRANSFER, el action lanza 422 `MISSING_REFUND_SOURCE`. Para pagos CASH,
 * el reembolso siempre va a la caja del actor que anula (paridad PlacePos
 * `voidSale`).
 *
 * Si hay múltiples pagos TRANSFER mixtos (uno a bank A, otro a wallet B),
 * el cliente debe llamar a un solo destino — los reembolsos se aplican en
 * una sola cuenta. Si el cliente necesita reembolsar a cuentas distintas
 * por pago, debe hacer el flujo manual de NC parcial.
 */
export class VoidSaleDto {
  @ApiPropertyOptional({ example: 'Cliente devolvió la mercancía' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @ApiPropertyOptional({
    type: SaleCorrectionSourceDto,
    description:
      'Cuenta destino del reembolso TRANSFER (bank/wallet). Obligatorio si la venta tiene pagos TRANSFER.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleCorrectionSourceDto)
  refund_source?: SaleCorrectionSourceDto | null;
}
