import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import type { AppConfig } from '@/config/app.config';
import { IssueActivationTokenAction } from '@/modules/auth/actions/issue-activation-token.action';
import { buildActivationUrl } from '@/modules/auth/internal/activation-token';
import { SendWelcomeEmailAction } from '@/modules/mail/actions/send-welcome-email.action';
import { maskEmail } from '@/modules/mail/internal/mail-address';
import { User, UserType } from '@/modules/users/entities/user.entity';

export interface ResendActivationResult {
  sent: boolean;
  /** Dirección a la que salió el correo, tal cual: el operador debe poder leerla. */
  email: string;
  /** Vencimiento del enlace nuevo. */
  expiresAt: string;
}

/**
 * Reemite el enlace de activación de un owner y le reenvía el correo.
 *
 * Lo dispara el operador desde el panel cuando el enlace venció o se perdió.
 * A diferencia del resto de correos del sistema, este SÍ espera el envío y SÍ
 * falla si el proveedor rechaza: el operador acaba de pulsar un botón que dice
 * "reenviar", y decirle que salió cuando no salió lo dejaría esperando una
 * respuesta del cliente que nunca va a llegar.
 */
@Injectable()
export class ResendActivationAction {
  private readonly logger = new Logger(ResendActivationAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly issueActivationTokenAction: IssueActivationTokenAction,
    private readonly sendWelcomeEmailAction: SendWelcomeEmailAction,
    private readonly configService: ConfigService,
  ) {}

  async execute(companyId: number): Promise<ResendActivationResult> {
    const owner = await this.dataSource.getRepository(User).findOne({
      where: { company_id: String(companyId), type: UserType.OWNER },
      relations: { company: true },
    });

    if (!owner) {
      throw new NotFoundException('No se encontró el dueño de esta cuenta.');
    }

    if (owner.activated_at) {
      // Reemitir aquí invalidaría un enlace que ya no hace falta y confundiría
      // al cliente con un correo que le pide algo que ya hizo.
      throw new ConflictException({
        message: 'Esta cuenta ya está activada.',
        payload: { code: 'ACCOUNT_ALREADY_ACTIVATED' },
      });
    }

    const issued = await this.dataSource.transaction((manager) =>
      this.issueActivationTokenAction.execute(manager, owner.id),
    );

    const baseUrl = this.configService.getOrThrow<AppConfig>('app').activationBaseUrl;
    const sent = await this.sendWelcomeEmailAction.execute({
      customer_name: owner.name,
      customer_email: owner.email,
      company_name: owner.company?.name ?? '',
      activation_url: buildActivationUrl(baseUrl, issued.token),
    });

    if (!sent) {
      // El token nuevo ya invalidó al anterior, así que no hay vuelta atrás
      // limpia; lo que sí se puede es decir la verdad y dejar reintentar.
      throw new ConflictException({
        message:
          'Se generó un enlace nuevo pero el correo no pudo salir. Revisa el estado del servidor de envíos e intenta otra vez.',
        payload: { code: 'ACTIVATION_EMAIL_NOT_SENT' },
      });
    }

    this.logger.log(`Activación reenviada a ${maskEmail(owner.email)} (company ${companyId}).`);

    return {
      sent: true,
      email: owner.email,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }
}
