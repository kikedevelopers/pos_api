import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import 'dayjs/locale/es';

import type { EmailAlertsConfig } from '@/config/email-alerts.config';
import { MailService } from '@/modules/mail/mail.service';
import { renderEmail } from '@/modules/mail/templates/render';
import { User, UserType } from '@/modules/users/entities/user.entity';
import { Company } from '@/modules/companies/entities/company.entity';

import { nowBogota } from '@/common/utils/dayjs';

import { ALERT_TYPE_CREDIT_DUE_TODAY } from '../constants';
import { CreditDueTodayEmail } from '../emails/credit-due-today';
import { AlertPdfTokenService } from '../internal/alert-pdf-token.service';
import { buildMockCreditsDueToday } from '../internal/mock-credits';
import { GetCreditsDueTodayAction } from './get-credits-due-today.action';

export interface SendCreditAlertResult {
  sent: boolean;
  recipientEmail: string | null;
  count: number;
  totalBalance: number;
  date: string;
  reason?: 'no-credits' | 'no-owner' | 'mail-disabled' | 'error';
}

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Envía (al OWNER, a nadie más) la alerta "créditos que vencen hoy". Patrón del
 * módulo de correo: NUNCA lanza — un fallo de correo no debe tumbar el cron ni
 * el endpoint; se deja en el log y se devuelve `sent:false`.
 *
 *   - `mock=true` (solo pruebas dev): usa datos ficticios y SIEMPRE arma el
 *     correo, aunque no haya créditos reales.
 *   - `mock=false` (producción/cron): si NO hay créditos que venzan hoy, NO
 *     envía correo (requisito del producto).
 */
@Injectable()
export class SendCreditDueTodayAlertAction {
  private readonly logger = new Logger(SendCreditDueTodayAlertAction.name);
  private readonly cfg: EmailAlertsConfig;

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(Company) private readonly companiesRepo: Repository<Company>,
    private readonly getCreditsDueToday: GetCreditsDueTodayAction,
    private readonly mailService: MailService,
    private readonly tokenService: AlertPdfTokenService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<EmailAlertsConfig>('emailAlerts');
  }

  async execute(companyId: number, options: { mock?: boolean } = {}): Promise<SendCreditAlertResult> {
    const mock = options.mock === true;
    const date = nowBogota().format('YYYY-MM-DD');

    try {
      const owner = await this.usersRepo.findOne({
        where: { company_id: String(companyId), type: UserType.OWNER },
      });
      if (!owner?.email) {
        this.logger.warn(`company ${companyId}: sin owner/correo, no se envía la alerta de cartera`);
        return { sent: false, recipientEmail: null, count: 0, totalBalance: 0, date, reason: 'no-owner' };
      }

      const summary = mock
        ? buildMockCreditsDueToday(date)
        : await this.getCreditsDueToday.execute(companyId, date);

      // Sin créditos que venzan hoy → no se envía nada (salvo prueba mock).
      if (!mock && summary.count === 0) {
        return {
          sent: false,
          recipientEmail: owner.email,
          count: 0,
          totalBalance: 0,
          date,
          reason: 'no-credits',
        };
      }

      if (!this.mailService.isEnabled()) {
        this.logger.warn('MailService deshabilitado; no se envía la alerta de cartera');
        return {
          sent: false,
          recipientEmail: owner.email,
          count: summary.count,
          totalBalance: summary.totalBalance,
          date,
          reason: 'mail-disabled',
        };
      }

      const company = await this.companiesRepo.findOne({ where: { id: String(companyId) } });
      const companyName = company?.name ?? 'Tu negocio';
      const dateLabel = nowBogota().locale('es').format('DD [de] MMMM [de] YYYY');
      const totalLabel = COP.format(Math.round(summary.totalBalance));

      const token = await this.tokenService.sign({
        cid: companyId,
        uid: Number(owner.id),
        date,
        type: ALERT_TYPE_CREDIT_DUE_TODAY,
        ...(mock ? { mock: true } : {}),
      });
      const pdfUrl = `${this.cfg.apiPublicUrl}/email-alerts/credit-due-today/pdf?token=${encodeURIComponent(token)}`;

      const subject = `Hoy vencen ${summary.count} crédito${summary.count === 1 ? '' : 's'} · ${totalLabel}`;
      const email = await renderEmail(
        subject,
        CreditDueTodayEmail({
          company_name: companyName,
          date_label: dateLabel,
          count: summary.count,
          total_label: totalLabel,
          pdf_url: pdfUrl,
        }),
      );

      await this.mailService.send({
        to: owner.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });

      return {
        sent: true,
        recipientEmail: owner.email,
        count: summary.count,
        totalBalance: summary.totalBalance,
        date,
      };
    } catch (error) {
      this.logger.error(
        `Fallo enviando la alerta de cartera (company ${companyId}): ${String(error)}`,
      );
      return { sent: false, recipientEmail: null, count: 0, totalBalance: 0, date, reason: 'error' };
    }
  }
}
