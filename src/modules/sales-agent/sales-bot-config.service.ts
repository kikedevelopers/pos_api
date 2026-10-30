import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TelegramClient, type TelegramBotIdentity } from './channels/telegram/telegram.client';
import {
  SALES_BOT_CHANNELS,
  SALES_BOT_PERSONALITIES,
  SalesBotConfigEntity,
  isSalesBotPersonality,
  type SalesBotChannel,
  type SalesBotPersonality,
} from './entities/sales-bot-config.entity';

/** Vista PÚBLICA de la config: lo que el cliente puede ver (sin el token). */
export interface SalesBotPublicConfig {
  channel: 'telegram';
  enabled: boolean;
  bot_name: string;
  personality: SalesBotPersonality;
  /** `true` si hay un token guardado (el valor nunca se expone). */
  has_token: boolean;
  /** @username del bot (getMe). Público. */
  bot_username: string | null;
  owner_chat_id: string | null;
  updated_at: string | null;
}

/** Entrada para guardar la config desde el menú del dueño. */
export interface UpdateSalesBotConfigInput {
  bot_name: string;
  personality: SalesBotPersonality;
  enabled: boolean;
  /**
   * Token de @BotFather. `undefined`/`''` = conservar el que ya haya guardado
   * (la UI no reenvía el secreto si no lo cambian). Un valor no vacío se valida
   * con getMe antes de guardar.
   */
  token?: string | null;
  owner_chat_id?: string | null;
}

/** Persona del bot que consume el prompt del vendedor. */
export interface SalesBotPersona {
  botName: string;
  personality: SalesBotPersonality;
}

/** Vista PÚBLICA de la config de WhatsApp (sin el token). */
export interface SalesBotWhatsappPublicConfig {
  channel: 'whatsapp';
  enabled: boolean;
  bot_name: string;
  personality: SalesBotPersonality;
  /** `true` si el negocio guardó un token propio (el valor nunca se expone). */
  has_token: boolean;
  phone_number_id: string | null;
  waba_id: string | null;
  owner_chat_id: string | null;
  updated_at: string | null;
}

/** Entrada para guardar la config de WhatsApp (modo manual). */
export interface UpdateWhatsappConfigInput {
  bot_name: string;
  personality: SalesBotPersonality;
  enabled: boolean;
  phone_number_id?: string | null;
  /** Token propio del negocio. `''`/`undefined` = conservar el guardado. */
  token?: string | null;
  waba_id?: string | null;
  owner_chat_id?: string | null;
}

/** Resultado de validar un token sin guardarlo. */
export interface TokenValidationResult {
  valid: boolean;
  bot_username: string | null;
  bot_name: string | null;
}

const MAX_BOT_NAME_LEN = 60;

/**
 * Acceso a la configuración del bot vendedor por negocio. Única fuente de la
 * verdad de `sales_bot_configs`. NO arranca ni detiene pollers: eso lo hace el
 * `TelegramBotManager`, que llama a este servicio para leer las configs.
 *
 * Seguridad: el `telegram_token` entra por aquí y nunca sale hacia el cliente.
 * Toda query filtra por `company_id`; nunca se acepta override del tenant.
 */
@Injectable()
export class SalesBotConfigService {
  private readonly logger = new Logger(SalesBotConfigService.name);

  constructor(
    @InjectRepository(SalesBotConfigEntity)
    private readonly repo: Repository<SalesBotConfigEntity>,
  ) {}

  /** Config de un canal del negocio (entidad cruda, con secretos). Uso interno. */
  getEntity(companyId: number, channel: SalesBotChannel): Promise<SalesBotConfigEntity | null> {
    return this.repo.findOne({
      where: { company_id: String(companyId), channel },
    });
  }

  /** Config de Telegram del negocio (entidad cruda, con token). Uso interno. */
  getTelegramEntity(companyId: number): Promise<SalesBotConfigEntity | null> {
    return this.getEntity(companyId, SALES_BOT_CHANNELS.TELEGRAM);
  }

  /** Vista pública para la UI (sin token). Defaults si el negocio no la tiene. */
  async getPublicConfig(companyId: number): Promise<SalesBotPublicConfig> {
    const entity = await this.getTelegramEntity(companyId);
    return toPublicConfig(entity);
  }

  /**
   * Nombre + personalidad para el prompt, del canal indicado. Defaults si no hay
   * config. Si el canal no es Telegram y su fila no tiene nombre, cae al de
   * Telegram (para no obligar a reconfigurar la persona en cada canal).
   */
  async getPersona(
    companyId: number,
    channel: SalesBotChannel = SALES_BOT_CHANNELS.TELEGRAM,
  ): Promise<SalesBotPersona> {
    const entity = await this.getEntity(companyId, channel);
    let botName = entity?.bot_name?.trim() || '';
    let personality = entity?.personality ?? SALES_BOT_PERSONALITIES.AMABLE_PROFESIONAL;

    if (!botName && channel !== SALES_BOT_CHANNELS.TELEGRAM) {
      const telegram = await this.getTelegramEntity(companyId);
      botName = telegram?.bot_name?.trim() || '';
      if (!entity) personality = telegram?.personality ?? personality;
    }

    return { botName, personality };
  }

  /** Todas las configs de Telegram habilitadas y con token (para el manager). */
  listRunnableTelegram(): Promise<SalesBotConfigEntity[]> {
    return this.repo
      .createQueryBuilder('config')
      .where('config.channel = :channel', { channel: SALES_BOT_CHANNELS.TELEGRAM })
      .andWhere('config.enabled = true')
      .andWhere('config.telegram_token IS NOT NULL')
      .andWhere("config.telegram_token <> ''")
      .getMany();
  }

  /**
   * Valida un token contra Telegram (getMe) SIN guardarlo. Para el botón
   * "Verificar" de la UI. Nunca lanza por un token inválido: devuelve valid=false.
   */
  async validateToken(token: string): Promise<TokenValidationResult> {
    const identity = await this.probeToken(token);
    return {
      valid: identity !== null,
      bot_username: identity?.username ?? null,
      bot_name: identity?.firstName ?? null,
    };
  }

  /**
   * Crea o actualiza la config de Telegram del negocio. Valida nombre,
   * personalidad y, si llega un token nuevo, lo verifica con getMe antes de
   * guardarlo. No permite habilitar el bot sin un token válido.
   */
  async upsertTelegram(
    companyId: number,
    input: UpdateSalesBotConfigInput,
  ): Promise<SalesBotPublicConfig> {
    const botName = (input.bot_name ?? '').trim();
    if (botName.length > MAX_BOT_NAME_LEN) {
      throw new BadRequestException(
        `El nombre del bot no puede superar ${MAX_BOT_NAME_LEN} caracteres.`,
      );
    }
    if (!isSalesBotPersonality(input.personality)) {
      throw new BadRequestException('Personalidad del bot no válida.');
    }

    const existing = await this.getTelegramEntity(companyId);
    const entity =
      existing ??
      this.repo.create({
        company_id: String(companyId),
        channel: SALES_BOT_CHANNELS.TELEGRAM,
      });

    entity.bot_name = botName;
    entity.personality = input.personality;
    entity.owner_chat_id = normalizeNullable(input.owner_chat_id);

    // Token nuevo → validar y adoptar identidad. Token vacío → conservar el actual.
    const newToken = (input.token ?? '').trim();
    if (newToken.length > 0 && newToken !== entity.telegram_token) {
      const identity = await this.probeToken(newToken);
      if (!identity) {
        throw new BadRequestException(
          'El token de Telegram no es válido o Telegram no responde. Revísalo e inténtalo de nuevo.',
        );
      }
      entity.telegram_token = newToken;
      entity.telegram_bot_username = identity.username;
      entity.telegram_bot_id = identity.id;
    }

    // No se puede ENCENDER el bot sin un token guardado.
    if (input.enabled && !entity.telegram_token) {
      throw new BadRequestException(
        'Para activar el bot primero debes guardar un token de Telegram válido.',
      );
    }
    entity.enabled = Boolean(input.enabled);

    const saved = await this.repo.save(entity);
    return toPublicConfig(saved);
  }

  /* ----------------------------- WhatsApp ----------------------------- */

  /** Vista pública de la config de WhatsApp (sin token). Defaults si no la tiene. */
  async getWhatsappPublicConfig(companyId: number): Promise<SalesBotWhatsappPublicConfig> {
    const entity = await this.getEntity(companyId, SALES_BOT_CHANNELS.WHATSAPP);
    return toWhatsappPublicConfig(entity);
  }

  /**
   * Busca el negocio ACTIVO dueño de un `phone_number_id` de WhatsApp. Lo usa el
   * webhook para rutear el mensaje entrante al tenant correcto.
   */
  findActiveWhatsappByPhoneNumberId(phoneNumberId: string): Promise<SalesBotConfigEntity | null> {
    const trimmed = phoneNumberId.trim();
    if (!trimmed) return Promise.resolve(null);
    return this.repo.findOne({
      where: {
        channel: SALES_BOT_CHANNELS.WHATSAPP,
        enabled: true,
        whatsapp_phone_number_id: trimmed,
      },
    });
  }

  /**
   * Crea o actualiza la config de WhatsApp del negocio (modo manual). No valida
   * contra Meta (el token/numero se prueban al enviar); sí exige un
   * `phone_number_id` para poder activar, y que no lo use otro negocio.
   */
  async upsertWhatsapp(
    companyId: number,
    input: UpdateWhatsappConfigInput,
  ): Promise<SalesBotWhatsappPublicConfig> {
    const botName = (input.bot_name ?? '').trim();
    if (botName.length > MAX_BOT_NAME_LEN) {
      throw new BadRequestException(
        `El nombre del bot no puede superar ${MAX_BOT_NAME_LEN} caracteres.`,
      );
    }
    if (!isSalesBotPersonality(input.personality)) {
      throw new BadRequestException('Personalidad del bot no válida.');
    }

    const existing = await this.getEntity(companyId, SALES_BOT_CHANNELS.WHATSAPP);
    const entity =
      existing ??
      this.repo.create({
        company_id: String(companyId),
        channel: SALES_BOT_CHANNELS.WHATSAPP,
      });

    entity.bot_name = botName;
    entity.personality = input.personality;
    entity.owner_chat_id = normalizeNullable(input.owner_chat_id);
    entity.whatsapp_phone_number_id = normalizeNullable(input.phone_number_id);
    entity.whatsapp_waba_id = normalizeNullable(input.waba_id);

    // Token propio opcional: solo se reemplaza si mandan uno nuevo no vacío.
    const newToken = (input.token ?? '').trim();
    if (newToken.length > 0) {
      entity.whatsapp_access_token = newToken;
    }

    if (input.enabled && !entity.whatsapp_phone_number_id) {
      throw new BadRequestException(
        'Para activar WhatsApp primero guarda el Phone number ID de tu número.',
      );
    }
    entity.enabled = Boolean(input.enabled);

    try {
      const saved = await this.repo.save(entity);
      return toWhatsappPublicConfig(saved);
    } catch (error) {
      // El índice único de phone_number_id puede reventar si otro negocio ya lo usa.
      if (isUniqueViolation(error)) {
        throw new BadRequestException(
          'Ese número (Phone number ID) ya está configurado en otro negocio.',
        );
      }
      throw error;
    }
  }

  /** Lanza getMe con el token y devuelve la identidad, o null si no es válido. */
  private async probeToken(token: string): Promise<TelegramBotIdentity | null> {
    const trimmed = token.trim();
    if (!trimmed) return null;
    try {
      return await new TelegramClient(trimmed).getMe();
    } catch (error) {
      this.logger.warn({ err: error }, 'Fallo validando token de Telegram');
      return null;
    }
  }
}

const normalizeNullable = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toPublicConfig = (entity: SalesBotConfigEntity | null): SalesBotPublicConfig => ({
  channel: 'telegram',
  enabled: entity?.enabled ?? false,
  bot_name: entity?.bot_name ?? '',
  personality: entity?.personality ?? SALES_BOT_PERSONALITIES.AMABLE_PROFESIONAL,
  has_token: Boolean(entity?.telegram_token),
  bot_username: entity?.telegram_bot_username ?? null,
  owner_chat_id: entity?.owner_chat_id ?? null,
  updated_at: entity?.updated_at ? entity.updated_at.toISOString() : null,
});

const toWhatsappPublicConfig = (
  entity: SalesBotConfigEntity | null,
): SalesBotWhatsappPublicConfig => ({
  channel: 'whatsapp',
  enabled: entity?.enabled ?? false,
  bot_name: entity?.bot_name ?? '',
  personality: entity?.personality ?? SALES_BOT_PERSONALITIES.AMABLE_PROFESIONAL,
  has_token: Boolean(entity?.whatsapp_access_token),
  phone_number_id: entity?.whatsapp_phone_number_id ?? null,
  waba_id: entity?.whatsapp_waba_id ?? null,
  owner_chat_id: entity?.owner_chat_id ?? null,
  updated_at: entity?.updated_at ? entity.updated_at.toISOString() : null,
});

/** `true` si el error de BD es una violación de índice único (Postgres 23505). */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: string }).code === '23505';
