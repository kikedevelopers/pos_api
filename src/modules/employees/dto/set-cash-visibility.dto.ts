import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Payload de `PUT /employees/:id/cash-visibility`.
 *
 * Concede (`true`) o revoca (`false`) el permiso del empleado para ver el saldo
 * y el historial de caja en el POS. Owner-only. Paridad PlacePos.
 */
export class SetCashVisibilityDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  can_view_cash!: boolean;
}
