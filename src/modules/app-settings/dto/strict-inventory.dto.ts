import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Configuración global de control estricto de inventario — espejo de
 * `placepos/src/renderer/src/api/requests/app-settings/types.ts →
 * StrictInventoryConfig`.
 *
 * `enabled=true` bloquea cualquier venta que dejaría el stock negativo
 * (salvo override_stock con rol owner/superadmin en el endpoint /payments).
 */
export class StrictInventoryConfigDto {
  @ApiProperty({ example: false })
  enabled!: boolean;
}

/**
 * Payload de `PUT /app-settings/strict-inventory`. Solo `owner`/`superadmin`
 * pueden mutar este flag — el guard de rol vive en el controller.
 */
export class UpdateStrictInventoryDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  enabled!: boolean;
}
