import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Configuración del flag «habilitar Préstamo a Tercero en la ventana de Cobro
 * de Pedido» — key `enable_third_party_loan`.
 *
 * `enabled=true` habilita el medio "Préstamo a Tercero" (convierte un pedido en
 * `ticket_type = 'LOAN'`). Default FALSE: la feature viene apagada hasta que un
 * admin la active. El backend REVALIDA este flag contra la BD (fail-closed) en
 * `POST /sales/:id/loan`; el front solo controla la visibilidad del botón.
 */
export class ThirdPartyLoanConfigDto {
  @ApiProperty({ example: false })
  enabled!: boolean;
}

/**
 * Payload de `PUT /app-settings/third-party-loan`. Solo un administrador
 * (canAccessSettings) puede mutar este flag — el guard vive en el controller.
 */
export class UpdateThirdPartyLoanDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  enabled!: boolean;
}
