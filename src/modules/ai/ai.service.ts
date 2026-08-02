import { Injectable } from '@nestjs/common';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { GenerateAiGreetingAction, type AiGreeting } from './actions/generate-ai-greeting.action';
import { ResolveAiActorAction } from './actions/resolve-ai-actor.action';
import {
  StreamAiChatAction,
  type AiStreamEvent,
  type StreamAiChatParams,
} from './actions/stream-ai-chat.action';
import { GeminiClient } from './internal/gemini-client';
import { ASSISTANT_NAME } from './internal/system-prompt';
import { toolSummariesFor, type AiToolSummary } from './internal/tool-catalog';

export type { AiStreamEvent, AiGreeting, AiToolSummary };

/** Estado del módulo que el cliente consulta antes de abrir el chat. */
export interface AiStatus {
  enabled: boolean;
  /** Nombre del asistente. El cliente lo muestra tal cual. */
  assistantName: string;
  defaultModel: string;
  models: string[];
  /** Herramientas que ESTE usuario puede usar de verdad (según sus permisos). */
  tools: AiToolSummary[];
}

/**
 * Facade del módulo `ai`. Sin lógica: delega en las actions.
 */
@Injectable()
export class AiService {
  constructor(
    private readonly streamAiChat: StreamAiChatAction,
    private readonly generateGreeting: GenerateAiGreetingAction,
    private readonly resolveActor: ResolveAiActorAction,
    private readonly geminiClient: GeminiClient,
  ) {}

  async status(user: AuthUser, companyId: number): Promise<AiStatus> {
    const actor = await this.resolveActor.execute(user, companyId);

    return {
      enabled: this.geminiClient.isEnabled(),
      assistantName: ASSISTANT_NAME,
      defaultModel: this.geminiClient.resolveModel(),
      models: this.geminiClient.allowedModels,
      tools: toolSummariesFor(actor),
    };
  }

  greeting(user: AuthUser, companyId: number): Promise<AiGreeting> {
    return this.generateGreeting.execute(user, companyId);
  }

  chat(params: StreamAiChatParams): Promise<void> {
    return this.streamAiChat.execute(params);
  }
}
