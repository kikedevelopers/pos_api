import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@/config/app.config';
import type { MailConfig } from '@/config/mail.config';

import {
  MAIL_DRIVER,
  MailDeliveryError,
  type MailDriver,
  type MailMessage,
  type MailSendResult,
} from './drivers/mail-driver.interface';
import { invalidRecipients, maskEmail, normalizeRecipients } from './internal/mail-address';
import {
  MailStatusStore,
  resolveMailStatusLevel,
  type MailActivitySnapshot,
  type MailStatusLevel,
} from './internal/mail-status.store';

/**
 * Pausa antes del único reintento. Suficiente para superar un límite de envíos
 * "por segundo", que es el fallo transitorio más habitual.
 */
const RETRY_DELAY_MS = 1500;

/** Lo que pide quien quiera mandar un correo. Acepta un destinatario o varios. */
export interface SendMailInput {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  from?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
}

/** Estado completo del servidor de envíos, tal como lo pinta el panel. */
export interface MailStatus {
  driver: string;
  configured: boolean;
  healthy: boolean;
  level: MailStatusLevel;
  summary: string;
  detail: string;
  latencyMs: number | null;
  from: string;
  environment: string;
  activity: MailActivitySnapshot;
  checkedAt: string;
}

/**
 * API pública del correo. TODO el resto de pos_api usa este servicio y ninguna
 * otra pieza del módulo: quien envíe un correo no sabe —ni debe saber— si sale
 * por Resend, por SMTP o por el log.
 *
 * Responsabilidades propias (las que no delega al driver):
 *   - normalizar y validar destinatarios antes de gastar una llamada al proveedor,
 *   - registrar cada envío en `MailStatusStore` (de ahí sale el semáforo),
 *   - reintentar UNA vez los fallos transitorios.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly status = new MailStatusStore();

  constructor(
    @Inject(MAIL_DRIVER) private readonly driver: MailDriver,
    private readonly configService: ConfigService,
  ) {}

  private get config(): MailConfig {
    return this.configService.getOrThrow<MailConfig>('mail');
  }

  private get environment(): string {
    return this.configService.getOrThrow<AppConfig>('app').nodeEnv;
  }

  /** Nombre del proveedor activo. */
  get providerName(): string {
    return this.driver.name;
  }

  /** `false` = faltan credenciales; enviar sería un fallo garantizado. */
  isEnabled(): boolean {
    return this.driver.isConfigured();
  }

  /** Remitente por defecto configurado en el servidor. */
  get defaultFrom(): string {
    return this.config.from;
  }

  /**
   * Envía un correo. Lanza `BadRequestException` si los destinatarios no sirven
   * y `MailDeliveryError` si el proveedor rechaza el envío.
   */
  async send(input: SendMailInput): Promise<MailSendResult> {
    // La validación va ANTES del bloque que registra actividad a propósito: un
    // destinatario mal escrito es un error de quien llama, no una falla del
    // servidor de envíos. Contarlo pintaría el panel de rojo justo cuando el
    // servidor está haciendo lo correcto (rechazarlo sin gastar una llamada).
    const to = normalizeRecipients(input.to);
    if (to.length === 0) {
      throw new BadRequestException('Se requiere al menos un destinatario.');
    }
    const invalid = invalidRecipients(to);
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Dirección de correo inválida: ${invalid.map(maskEmail).join(', ')}`,
      );
    }

    const message: MailMessage = {
      to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      from: input.from,
      replyTo: input.replyTo,
      cc: input.cc ? normalizeRecipients(input.cc) : undefined,
      bcc: input.bcc ? normalizeRecipients(input.bcc) : undefined,
    };

    try {
      const result = await this.trySendWithRetry(message);
      this.status.recordSuccess();
      this.logger.log(
        `Correo enviado por ${result.provider} a ${to.map(maskEmail).join(', ')} (${result.durationMs} ms).`,
      );
      return result;
    } catch (e) {
      const friendly = e instanceof MailDeliveryError ? e.message : 'No se pudo enviar el correo.';
      this.status.recordFailure(friendly);
      throw e;
    }
  }

  /**
   * Un fallo transitorio (5xx, límite de tasa, socket caído) se reintenta UNA
   * vez, tras una pausa. Los rechazos definitivos —credencial inválida, dominio
   * sin verificar— no se reintentan: solo retrasarían el error sin cambiarlo.
   *
   * La pausa NO es opcional: el fallo transitorio más común es el límite de
   * envíos por segundo, y reintentar de inmediato vuelve a chocar con él.
   */
  private async trySendWithRetry(message: MailMessage): Promise<MailSendResult> {
    try {
      return await this.driver.send(message);
    } catch (e) {
      if (e instanceof MailDeliveryError && e.retriable) {
        this.logger.warn(`Reintentando envío tras fallo transitorio: ${e.message}`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        return this.driver.send(message);
      }
      throw e;
    }
  }

  /**
   * Diagnóstico completo del servidor de envíos: credenciales (`verify`, sin
   * enviar nada) + comportamiento real de los envíos de este proceso.
   */
  async getStatus(): Promise<MailStatus> {
    const configured = this.driver.isConfigured();
    const health = await this.driver.verify();
    const activity = this.status.snapshot();
    const { level, summary } = resolveMailStatusLevel({
      configured,
      healthy: health.healthy,
      driver: this.driver.name,
      activity,
    });

    return {
      driver: this.driver.name,
      configured,
      healthy: health.healthy,
      level,
      summary,
      detail: health.detail,
      latencyMs: health.latencyMs,
      from: this.config.from,
      environment: this.environment,
      activity,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Solo para tests: borra los contadores del proceso. */
  resetActivity(): void {
    this.status.reset();
  }
}
