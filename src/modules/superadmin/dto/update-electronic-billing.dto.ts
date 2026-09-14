import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Payload de `PATCH /superadmin/tenants/:companyId/electronic-billing`.
 *
 * Único campo por ahora: el interruptor de FE del negocio. La configuración
 * fiscal restante (NIT, resolución, prefijo, credenciales del API externo…) se
 * sumará a este DTO en fases siguientes.
 */
export class UpdateElectronicBillingDto {
  @ApiProperty({ example: true, description: 'Habilita/inhabilita la FE del negocio.' })
  @IsBoolean()
  enabled!: boolean;
}
