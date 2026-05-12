import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Payload de `PUT /inventory/:id/show-in-pos`.
 *
 * Diverge de PlacePos: PlacePos expone `PUT /inventory/show-in-pos` (bulk
 * con `{ ids, show_in_pos }`). Aquí ofrecemos también la versión individual
 * por id (más RESTful y útil para frontends nuevos) — el bulk se mantiene
 * en `PUT /inventory/show-in-pos`.
 */
export class ToggleShowInPosDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  show_in_pos!: boolean;
}
