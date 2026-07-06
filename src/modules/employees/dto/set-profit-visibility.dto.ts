import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Payload de `PUT /employees/:id/profit-visibility`.
 *
 * Concede (`true`) o revoca (`false`) el permiso del empleado para ver
 * márgenes y ganancias. Owner-only. Paridad PlacePos.
 */
export class SetProfitVisibilityDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  can_view_profit!: boolean;
}
