import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Payload de `PATCH /superadmin/tenants/:companyId/sales-agent-access`. */
export class UpdateSalesAgentAccessDto {
  @ApiProperty({
    example: true,
    description: 'Habilita/inhabilita el asistente de ventas de ESTA company (principal o sucursal).',
  })
  @IsBoolean()
  enabled!: boolean;
}
