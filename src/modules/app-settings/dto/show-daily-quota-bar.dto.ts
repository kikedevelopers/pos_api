import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Configuración del flag «mostrar barra de cuota diaria en el POS» — espejo de
 * `placepos/src/renderer/src/api/requests/app-settings/types.ts →
 * ShowDailyQuotaBarConfig`.
 *
 * `enabled=true` hace que el POS muestre la barra de progreso de la cuota diaria
 * (semáforo). Solo la ven los admins (owner o empleado con rol admin). Default:
 * false — la barra viene oculta hasta que un admin la active.
 */
export class ShowDailyQuotaBarConfigDto {
  @ApiProperty({ example: false })
  enabled!: boolean;
}

/**
 * Payload de `PUT /app-settings/show-daily-quota-bar`. Solo un administrador
 * (canAccessSettings) puede mutar este flag — el guard vive en el controller.
 */
export class UpdateShowDailyQuotaBarDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  enabled!: boolean;
}
