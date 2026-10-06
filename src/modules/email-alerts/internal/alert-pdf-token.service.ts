import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';

import type { EmailAlertsConfig } from '@/config/email-alerts.config';

/**
 * Contenido del token autocontenido que viaja en el enlace del correo. Lleva
 * TODA la información necesaria para regenerar el reporte on-demand (company,
 * usuario, fecha y tipo), sin tocar la base para validar el token mismo.
 */
export interface AlertPdfTokenPayload {
  /** company_id del negocio dueño del reporte. */
  cid: number;
  /** user_id del owner (auditoría). */
  uid: number;
  /** Fecha del reporte, YYYY-MM-DD (hora Colombia). */
  date: string;
  /** Tipo de alerta (`ALERT_TYPE_*`). */
  type: string;
  /** Solo en pruebas (dev): la ruta devuelve datos mock en vez de consultar. */
  mock?: boolean;
}

/**
 * Firma y verifica el token del enlace de descarga del PDF. Secreto y vigencia
 * salen de la config `emailAlerts`. El token es un JWT firmado (HS256) con un
 * secreto DEDICADO — distinto del de sesión — para que el enlace no dé acceso a
 * nada más que a su propio PDF.
 */
@Injectable()
export class AlertPdfTokenService {
  private readonly cfg: EmailAlertsConfig;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<EmailAlertsConfig>('emailAlerts');
  }

  sign(payload: AlertPdfTokenPayload): Promise<string> {
    // `expiresIn` del env es un string genérico ('7d'); el tipo de @nestjs/jwt
    // espera el template `StringValue` de `ms`, así que acotamos las opciones.
    const options: JwtSignOptions = {
      secret: this.cfg.pdfTokenSecret,
      expiresIn: this.cfg.pdfTokenExpiresIn as JwtSignOptions['expiresIn'],
    };
    return this.jwt.signAsync(payload, options);
  }

  verify(token: string): Promise<AlertPdfTokenPayload> {
    return this.jwt.verifyAsync<AlertPdfTokenPayload>(token, {
      secret: this.cfg.pdfTokenSecret,
    });
  }
}
