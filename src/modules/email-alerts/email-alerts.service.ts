import { Injectable } from '@nestjs/common';

import {
  GetEmailAlertsSettingsAction,
  type EmailAlertsSettings,
} from './actions/get-email-alerts-settings.action';
import { SetEmailAlertEnabledAction } from './actions/set-email-alert-enabled.action';
import {
  SendCreditDueTodayAlertAction,
  type SendCreditAlertResult,
} from './actions/send-credit-due-today-alert.action';
import { GenerateCreditsPdfFromTokenAction } from './actions/generate-credits-pdf-from-token.action';
import type { EmailAlertType } from './constants';

export type { EmailAlertsSettings, SendCreditAlertResult };

/** Facade del módulo `email-alerts`. Solo delega. */
@Injectable()
export class EmailAlertsService {
  constructor(
    private readonly getSettings: GetEmailAlertsSettingsAction,
    private readonly setEnabled: SetEmailAlertEnabledAction,
    private readonly sendCreditAlert: SendCreditDueTodayAlertAction,
    private readonly generatePdf: GenerateCreditsPdfFromTokenAction,
  ) {}

  getSettingsFor(companyId: number): Promise<EmailAlertsSettings> {
    return this.getSettings.execute(companyId);
  }

  setAlertEnabled(
    companyId: number,
    type: EmailAlertType,
    enabled: boolean,
  ): Promise<{ type: EmailAlertType; enabled: boolean }> {
    return this.setEnabled.execute(companyId, type, enabled);
  }

  /** Prueba (dev): envía la alerta de créditos con datos mock al owner. */
  sendCreditDueTodayTest(companyId: number): Promise<SendCreditAlertResult> {
    return this.sendCreditAlert.execute(companyId, { mock: true });
  }

  generateCreditsPdf(token: string): Promise<{ buffer: Buffer; filename: string }> {
    return this.generatePdf.execute(token);
  }
}
