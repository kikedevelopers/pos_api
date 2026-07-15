import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Configuración del flag «incluir pedidos en informes» — espejo de
 * `placepos/src/renderer/src/api/requests/app-settings/types.ts →
 * IncludeOrdersInReportsConfig`.
 *
 * `enabled=true` hace que los tickets `ticket_type = 'ORDER'` (pedidos) se
 * sumen a los INGRESOS del informe de ventas y aparezcan como sub-línea de
 * facturación en Finanzas. NO toca caja/recaudo ni la ganancia cobrada
 * canónica. Default: false (comportamiento actual idéntico).
 */
export class IncludeOrdersInReportsConfigDto {
  @ApiProperty({ example: false })
  enabled!: boolean;
}

/**
 * Payload de `PUT /app-settings/include-orders-in-reports`. Solo
 * `owner`/`superadmin` pueden mutar este flag — el guard de rol vive en el
 * controller (paridad con `strict-inventory`).
 */
export class UpdateIncludeOrdersInReportsDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  enabled!: boolean;
}
