import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Payload de `PUT /employees/:id/charge-permission`.
 *
 * Concede (`true`) o revoca (`false`) el permiso del empleado para COBRAR
 * PEDIDOS (ORDER→SALE) en el POS. Owner-only. Actúa como override para roles no
 * elevados (Vendedor): los roles que conceden `canViewAllSales` (Cajero/Admin)
 * cobran igual, independientemente de este flag.
 */
export class SetChargePermissionDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  can_charge_orders!: boolean;
}
