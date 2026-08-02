import { Module } from '@nestjs/common';

import { DashboardModule } from '@/modules/dashboard/dashboard.module';
import { RolesModule } from '@/modules/roles/roles.module';
import { TreasuryModule } from '@/modules/treasury/treasury.module';

import { GenerateAiGreetingAction } from './actions/generate-ai-greeting.action';
import { ResolveAiActorAction } from './actions/resolve-ai-actor.action';
import { RunAiToolAction } from './actions/run-ai-tool.action';
import { StreamAiChatAction } from './actions/stream-ai-chat.action';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { GeminiClient } from './internal/gemini-client';

/**
 * Módulo `ai` — Place, el asistente del negocio (Google Gemini + herramientas
 * de solo lectura sobre la base del tenant).
 *
 * Reutiliza la maquinaria financiera canónica en vez de recalcular métricas:
 * `DashboardModule` (resumen del día, rendimiento, top productos) y
 * `TreasuryModule` (saldos de todas las cajas). `RolesModule` aporta la
 * resolución de permisos efectivos, con la que se decide qué herramientas se le
 * ofrecen al modelo.
 *
 * No declara entidades propias: no hay tabla nueva ni migración. El historial
 * del chat vive en el cliente.
 */
@Module({
  imports: [DashboardModule, TreasuryModule, RolesModule],
  controllers: [AiController],
  providers: [
    AiService,
    StreamAiChatAction,
    GenerateAiGreetingAction,
    RunAiToolAction,
    ResolveAiActorAction,
    GeminiClient,
  ],
  exports: [AiService],
})
export class AiModule {}
