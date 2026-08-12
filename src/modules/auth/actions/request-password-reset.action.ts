import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/config/app.config';
import { SendPasswordResetEmailAction } from '@/modules/mail/actions/send-password-reset-email.action';
import { maskEmail, normalizeEmail } from '@/modules/mail/internal/mail-address';
import { User, UserType } from '@/modules/users/entities/user.entity';

import { PasswordResetToken } from '../entities/password-reset-token.entity';
import {
  buildPasswordResetUrl,
  generatePasswordResetToken,
  hashPasswordResetToken,
  passwordResetExpiresAt,
} from '../internal/password-reset-token';

export interface RequestPasswordResetResult {
  sent: boolean;
  /** Dirección enmascarada: se muestra como confirmación de a dónde fue. */
  email: string;
}

/**
 * Envía el enlace para cambiar la contraseña.
 *
 * NOTA DE SEGURIDAD — enumeración de cuentas: este endpoint responde distinto
 * según el correo exista o no, y según esté activado o no. Es una decisión de
 * producto (que el usuario sepa exactamente qué le pasa) y tiene un costo:
 * cualquiera puede averiguar si una dirección está registrada. Lo que lo hace
 * asumible es el rate limit global (`ThrottlerGuard`); si algún día pesa más la
 * privacidad que la claridad, basta con responder siempre `sent: true` sin
 * distinguir el caso.
 */
@Injectable()
export class RequestPasswordResetAction {
  private readonly logger = new Logger(RequestPasswordResetAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly sendPasswordResetEmailAction: SendPasswordResetEmailAction,
    private readonly configService: ConfigService,
  ) {}

  async execute(rawEmail: string): Promise<RequestPasswordResetResult> {
    const email = normalizeEmail(rawEmail);

    const user = await this.dataSource.getRepository(User).findOne({
      where: { email, type: UserType.OWNER },
    });

    if (!user) {
      throw new NotFoundException({
        message: 'No encontramos ninguna cuenta con ese correo.',
        payload: { code: 'ACCOUNT_NOT_FOUND' },
      });
    }

    if (!user.activated_at) {
      // Cambiar la contraseña de una cuenta que nunca confirmó su correo no
      // sirve de nada: seguiría sin poder entrar. Lo que necesita es activarla.
      throw new ForbiddenException({
        message:
          'Esta cuenta todavía no está activada. Abre el correo de bienvenida y pulsa "Activar mi cuenta".',
        payload: { code: 'ACCOUNT_NOT_ACTIVATED' },
      });
    }

    const now = new Date();
    const token = generatePasswordResetToken();
    const expiresAt = passwordResetExpiresAt(now);

    await this.dataSource.transaction(async (manager) => {
      // Invalida los enlaces anteriores: varios enlaces vivos para cambiar la
      // misma contraseña multiplican la superficie sin ninguna ventaja.
      await manager
        .createQueryBuilder()
        .update(PasswordResetToken)
        .set({ used_at: now })
        .where('user_id = :userId AND used_at IS NULL', { userId: String(user.id) })
        .execute();

      await manager.save(
        manager.create(PasswordResetToken, {
          user_id: String(user.id),
          token_hash: hashPasswordResetToken(token),
          expires_at: expiresAt,
          used_at: null,
        }),
      );
    });

    const baseUrl = this.configService.getOrThrow<AppConfig>('app').activationBaseUrl;
    const sent = await this.sendPasswordResetEmailAction.execute({
      customer_name: user.name,
      customer_email: user.email,
      reset_url: buildPasswordResetUrl(baseUrl, token),
    });

    if (!sent) {
      // Decir "revisa tu correo" cuando el correo no salió deja a la persona
      // esperando algo que no va a llegar.
      throw new BadRequestException({
        message: 'No pudimos enviar el correo en este momento. Intenta de nuevo en unos minutos.',
        payload: { code: 'RESET_EMAIL_NOT_SENT' },
      });
    }

    this.logger.log(`Enlace de recuperación enviado a ${maskEmail(user.email)}.`);
    return { sent: true, email: maskEmail(user.email) };
  }
}
