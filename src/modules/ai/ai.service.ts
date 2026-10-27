import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import {
  AiAttachmentsAction,
  type AiAttachmentView,
  type UploadedAttachmentFile,
} from './actions/ai-attachments.action';
import { AiCreditsAction, type CreditReservation } from './actions/ai-credits.action';
import { GenerateAiGreetingAction, type AiGreeting } from './actions/generate-ai-greeting.action';
import { ResolveAiActorAction } from './actions/resolve-ai-actor.action';
import {
  StreamAiChatAction,
  type AiStreamEvent,
  type StreamAiChatParams,
} from './actions/stream-ai-chat.action';
import { GeminiClient } from './internal/gemini-client';
import type { AiCreditsStatus } from './internal/ai-usage';
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
  /** Preguntas diarias de la cuenta: con `remaining = 0` el chat se bloquea. */
  credits: AiCreditsStatus;
}

/** Mensaje para el cliente cuando la cuenta agotó sus preguntas del día. */
export const CREDITS_EXHAUSTED_MESSAGE =
  'Ya usaste todas las consultas de Place disponibles por hoy. Podrás volver a preguntarle mañana.';

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
    private readonly credits: AiCreditsAction,
    private readonly attachments: AiAttachmentsAction,
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
    const [actor, enabled, credits] = await Promise.all([
      this.resolveActor.execute(user, companyId),
      this.isAvailableFor(companyId),
      this.credits.status(companyId),
    ]);

    return {
      enabled,
      assistantName: ASSISTANT_NAME,
      defaultModel: this.geminiClient.resolveModel(),
      models: this.geminiClient.allowedModels,
      tools: toolSummariesFor(actor),
      credits,
    };
  }

  /**
   * Gate de un mensaje al chat: acceso habilitado Y un crédito del día. Reserva
   * el crédito ANTES de abrir el stream (atómico); sin créditos lanza 429
   * `AI_CREDITS_EXHAUSTED` como error HTTP normal.
   */
  async reserveChatCredit(companyId: number): Promise<CreditReservation> {
    await this.assertAvailableFor(companyId);
    const reservation = await this.credits.reserve(companyId);
    if (reservation) return reservation;
    throw new HttpException(
      {
        message: CREDITS_EXHAUSTED_MESSAGE,
        // El filtro global solo conserva `code` y `details` del payload.
        payload: {
          code: 'AI_CREDITS_EXHAUSTED',
          details: { credits: await this.credits.status(companyId) },
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Devuelve el crédito de un mensaje cuya respuesta falló. */
  refundChatCredit(reservation: CreditReservation): Promise<void> {
    return this.credits.refund(reservation);
  }

  async greeting(user: AuthUser, companyId: number): Promise<AiGreeting> {
    // Gate por cuenta: sin acceso no se gasta una llamada a Gemini para saludar.
    await this.assertAvailableFor(companyId);
    // Sin preguntas disponibles hoy, el saludo es el fijo: no se gasta un token.
    const credits = await this.credits.status(companyId);
    return this.generateGreeting.execute(user, companyId, Date.now(), credits.remaining > 0);
  }

  /**
   * Sube una foto o un PDF para el chat. Exige que Place esté habilitado, pero
   * no gasta consultas: el crédito se cobra al preguntar.
   */
  async uploadAttachment(
    user: AuthUser,
    companyId: number,
    file: UploadedAttachmentFile | undefined,
  ): Promise<AiAttachmentView> {
    await this.assertAvailableFor(companyId);
    return this.attachments.upload({ company_id: companyId, user_id: user.user_id, file });
  }

  async chat(params: StreamAiChatParams): Promise<void> {
    // Defensa en profundidad: el controller ya bloquea antes de abrir el stream,
    // pero re-validamos aquí por si se invoca el service por otra vía.
    await this.assertAvailableFor(params.companyId);
    return this.streamAiChat.execute(params);
  }
}
