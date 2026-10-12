import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
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
    @InjectRepository(Company)
    private readonly companiesRepo: Repository<Company>,
  ) {}

  /** `true` si la cuenta (company) tiene habilitado el acceso a Place. */
  private async isCompanyAiEnabled(companyId: number): Promise<boolean> {
    const company = await this.companiesRepo.findOne({
      where: { id: String(companyId) },
      select: { id: true, ai_enabled: true },
    });
    return company?.ai_enabled === true;
  }

  /**
   * Place está disponible para la cuenta si el servidor tiene llave de Gemini Y
   * la company tiene el acceso habilitado desde el panel superadmin.
   */
  async isAvailableFor(companyId: number): Promise<boolean> {
    if (!this.geminiClient.isEnabled()) return false;
    return this.isCompanyAiEnabled(companyId);
  }

  /** Lanza 403 (AI_NOT_ENABLED) si la cuenta no tiene acceso a Place. */
  async assertAvailableFor(companyId: number): Promise<void> {
    if (await this.isAvailableFor(companyId)) return;
    throw new ForbiddenException({
      message: 'El asistente Place no está habilitado para tu cuenta.',
      payload: { code: 'AI_NOT_ENABLED' },
    });
  }

  async status(user: AuthUser, companyId: number): Promise<AiStatus> {
    const [actor, enabled] = await Promise.all([
      this.resolveActor.execute(user, companyId),
      this.isAvailableFor(companyId),
    ]);

    return {
      enabled,
      assistantName: ASSISTANT_NAME,
      defaultModel: this.geminiClient.resolveModel(),
      models: this.geminiClient.allowedModels,
      tools: toolSummariesFor(actor),
    };
  }

  async greeting(user: AuthUser, companyId: number): Promise<AiGreeting> {
    // Gate por cuenta: sin acceso no se gasta una llamada a Gemini para saludar.
    await this.assertAvailableFor(companyId);
    return this.generateGreeting.execute(user, companyId);
  }

  async chat(params: StreamAiChatParams): Promise<void> {
    // Defensa en profundidad: el controller ya bloquea antes de abrir el stream,
    // pero re-validamos aquí por si se invoca el service por otra vía.
    await this.assertAvailableFor(params.companyId);
    return this.streamAiChat.execute(params);
  }
}
