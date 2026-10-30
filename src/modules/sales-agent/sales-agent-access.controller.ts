import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';

/**
 * `GET /sales-bot/access` — ¿el negocio tiene el asistente de ventas habilitado?
 * Lo consulta el front para mostrar u ocultar todo lo del asistente. Abierto a
 * cualquier usuario del negocio (no expone configuración).
 */
@ApiTags('sales-bot')
@ApiBearerAuth('bearer')
@Controller('sales-bot')
export class SalesAgentAccessController {
  constructor(private readonly access: SalesAgentAccessService) {}

  @Get('access')
  @ApiOperation({ summary: 'Si el negocio tiene el asistente de ventas habilitado.' })
  async getAccess(@CurrentCompany() companyId: number): Promise<{ enabled: boolean }> {
    return { enabled: await this.access.isEnabled(companyId) };
  }
}
