import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { DashboardModule } from '@/modules/dashboard/dashboard.module';
import { ExpensesModule } from '@/modules/expenses/expenses.module';
import { RolesModule } from '@/modules/roles/roles.module';
import { TreasuryModule } from '@/modules/treasury/treasury.module';

import { GenerateAiGreetingAction } from './actions/generate-ai-greeting.action';
import { ResolveAiActorAction } from './actions/resolve-ai-actor.action';
import { RunAiExpenseToolAction } from './actions/run-ai-expense-tool.action';
import { RunAiToolAction } from './actions/run-ai-tool.action';
import { StreamAiChatAction } from './actions/stream-ai-chat.action';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { GeminiClient } from './internal/gemini-client';

/**
 * Módulo `ai` — Place, el asistente del negocio (Google Gemini + herramientas
 * sobre la base del tenant: de lectura, y de gastos para administradores).
 *
 * Reutiliza la maquinaria financiera canónica en vez de recalcular métricas:
 * `DashboardModule` (resumen del día, rendimiento, top productos) y
 * `TreasuryModule` (saldos de todas las cajas). `RolesModule` aporta la
 * resolución de permisos efectivos, con la que se decide qué herramientas se le
 * ofrecen al modelo.
 *
 * `ExpensesModule` aporta `CreateExpenseAction`/`VoidExpenseAction`: las
 * herramientas de gastos escriben con la misma lógica que la app.
 *
 * No declara entidades: el historial del chat vive en el cliente. La única
 * tabla propia es `ai_pending_actions` (operaciones de gasto esperando el "sí"
 * del usuario), que se maneja con SQL plano.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Company]),
    DashboardModule,
    TreasuryModule,
    RolesModule,
    ExpensesModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    StreamAiChatAction,
    GenerateAiGreetingAction,
    RunAiToolAction,
    RunAiExpenseToolAction,
    ResolveAiActorAction,
    GeminiClient,
  ],
  exports: [AiService],
})
export class AiModule {}
