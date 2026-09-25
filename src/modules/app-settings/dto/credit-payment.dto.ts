import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Configuración del flag «habilitar pago a Crédito en la ventana de Cobro de
 * Pedido» — key `enable_credit_payment`.
 *
 * `enabled=true` muestra la tarjeta "Crédito" en el POS. Default TRUE: si la
 * fila no existe, el crédito queda visible (comportamiento histórico). Un admin
 * puede apagarlo para ocultar el crédito a TODOS los usuarios del negocio.
 */
export class CreditPaymentConfigDto {
  @ApiProperty({ example: true })
  enabled!: boolean;
}

/**
 * Payload de `PUT /app-settings/credit-payment`. Solo un administrador
 * (canAccessSettings) puede mutar este flag — el guard vive en el controller.
 */
export class UpdateCreditPaymentDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;
}
