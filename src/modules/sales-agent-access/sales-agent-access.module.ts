import { Module } from '@nestjs/common';

import { SalesAgentAccessService } from './sales-agent-access.service';
import { SalesAgentEnabledGuard } from './sales-agent-enabled.guard';

/**
 * Interruptor del asistente de ventas por negocio + registro de su consumo de
 * IA. Lo comparten el agente (`sales-agent`) y la ficha del catálogo
 * (`catalog-knowledge`) sin depender uno del otro.
 */
@Module({
  providers: [SalesAgentAccessService, SalesAgentEnabledGuard],
  exports: [SalesAgentAccessService, SalesAgentEnabledGuard],
})
export class SalesAgentAccessModule {}
