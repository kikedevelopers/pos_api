import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { EmailAlertsConfig } from '@/config/email-alerts.config';
import { AlertConfig } from '@/modules/alert-configs/entities/alert-config.entity';

import { APP_TIMEZONE } from '@/common/utils/dayjs';

import { ALERT_TYPE_CREDIT_DUE_TODAY } from './constants';
import { SendCreditDueTodayAlertAction } from './actions/send-credit-due-today-alert.action';

/**
 * Expresión cron del envío diario. Se lee del env al cargar la clase (el
 * decorador `@Cron` necesita un valor estático). Default: 7:00 a. m.
 */
const CREDIT_DUE_CRON = process.env.EMAIL_ALERTS_CRON?.trim() || '0 7 * * *';

/**
 * Disparo DIARIO de la alerta "créditos que vencen hoy". Recorre las companies
 * que tienen la alerta activa y, para cada una, intenta enviar (la action no
 * envía si no hay créditos que venzan hoy). ARRANCA APAGADO: solo corre si
 * `EMAIL_ALERTS_CRON_ENABLED=true`. Nunca lanza; traduce fallos a log.
 *
 * NOTA (igual que `BackupsScheduler`): si hubiera más de una instancia del API,
 * cada una correría su propio cron. Hoy el despliegue es de un solo contenedor.
 */
@Injectable()
export class EmailAlertsScheduler {
  private readonly logger = new Logger(EmailAlertsScheduler.name);
  private running = false;
  private readonly cfg: EmailAlertsConfig;

  constructor(
    @InjectRepository(AlertConfig) private readonly configsRepo: Repository<AlertConfig>,
    private readonly sendCreditAlert: SendCreditDueTodayAlertAction,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<EmailAlertsConfig>('emailAlerts');
  }

  @Cron(CREDIT_DUE_CRON, {
    name: 'email-alerts-credit-due-today',
    timeZone: APP_TIMEZONE,
  })
  async runDaily(): Promise<void> {
    if (!this.cfg.cronEnabled) {
      return;
    }
    if (this.running) {
      this.logger.warn('El envío diario de alertas de cartera ya está en curso; se omite.');
      return;
    }
    this.running = true;
    try {
      const rows = await this.configsRepo.find({
        where: { type: ALERT_TYPE_CREDIT_DUE_TODAY, enabled: true },
      });
      this.logger.log(`Alertas de cartera: ${rows.length} company(s) con la alerta activa.`);

      let sent = 0;
      for (const row of rows) {
        const result = await this.sendCreditAlert.execute(Number(row.company_id));
        if (result.sent) {
          sent += 1;
        }
      }
      this.logger.log(`Alertas de cartera: ${sent} correo(s) enviado(s).`);
    } catch (error) {
      this.logger.error(`Fallo en el envío diario de alertas de cartera: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
