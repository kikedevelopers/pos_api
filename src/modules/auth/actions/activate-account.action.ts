import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { maskEmail } from '@/modules/mail/internal/mail-address';
import { SendAccountActivatedEmailAction } from '@/modules/mail/actions/send-account-activated-email.action';
import { Company } from '@/modules/companies/entities/company.entity';
import { User } from '@/modules/users/entities/user.entity';

import { UserActivationToken } from '../entities/user-activation-token.entity';
import {
  describeActivationRejection,
  evaluateActivationToken,
  hashActivationToken,
  looksLikeActivationToken,
} from '../internal/activation-token';

export interface ActivateAccountResult {
  activated: boolean;
  /** `true` si la cuenta ya estaba activa: no es un error, es un doble clic. */
  already_activated: boolean;
  /** Nombre de pila, para saludar en la pantalla de éxito. */
  name: string;
  email: string;
}

/** Lo que devuelve la transacción: el resultado + lo que hace falta después. */
type ActivationOutcome = ActivateAccountResult & { company_id: string | null };

/**
 * Canjea el token del correo de bienvenida y activa la cuenta.
 *
 * Errores: SIEMPRE `BadRequestException` con un mensaje que distingue el motivo
 * (inválido / vencido / ya usado), porque aquí el usuario necesita saber qué
 * pasó para poder resolverlo — al revés que en el login, donde el mensaje es
 * deliberadamente uniforme para no filtrar qué cuentas existen. Un token de 32
 * bytes aleatorios no dice nada de ninguna cuenta: quien lo tiene es porque
 * recibió el correo.
 */
@Injectable()
export class ActivateAccountAction {
  private readonly logger = new Logger(ActivateAccountAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly sendAccountActivatedEmailAction: SendAccountActivatedEmailAction,
  ) {}

  async execute(rawToken: string): Promise<ActivateAccountResult> {
    const token = rawToken.trim();
    if (!looksLikeActivationToken(token)) {
      throw new BadRequestException({
        message: describeActivationRejection('invalid'),
        payload: { code: 'ACTIVATION_TOKEN_INVALID' },
      });
    }

    const tokenHash = hashActivationToken(token);
    const now = new Date();

    const result = await this.dataSource.transaction<ActivationOutcome>(async (manager) => {
      // `FOR UPDATE`: dos clics simultáneos en el botón del correo no pueden
      // canjear el mismo token dos veces.
      const record = await manager
        .createQueryBuilder(UserActivationToken, 'token')
        .setLock('pessimistic_write')
        .where('token.token_hash = :tokenHash', { tokenHash })
        .getOne();

      const verdict = evaluateActivationToken(record, now);

      if (!verdict.valid) {
        // Un token ya usado sobre una cuenta YA activa es el caso del doble
        // clic o del correo reenviado a sí mismo: no es un error que merezca
        // pantalla roja, la cuenta está lista igual.
        if (verdict.reason === 'used' && record) {
          const user = await manager.findOne(User, { where: { id: record.user_id } });
          if (user?.activated_at) {
            return {
              activated: true,
              already_activated: true,
              name: user.name,
              email: user.email,
              company_id: user.company_id,
            };
          }
        }
        throw new BadRequestException({
          message: describeActivationRejection(verdict.reason),
          payload: { code: `ACTIVATION_TOKEN_${verdict.reason.toUpperCase()}` },
        });
      }

      const user = await manager.findOne(User, { where: { id: verdict.record.user_id } });
      if (!user) {
        // El token vive con FK ON DELETE CASCADE, así que esto no debería
        // pasar; si pasa, el token no sirve para nada.
        throw new BadRequestException({
          message: describeActivationRejection('invalid'),
          payload: { code: 'ACTIVATION_TOKEN_INVALID' },
        });
      }

      const alreadyActivated = user.activated_at !== null;

      await manager.update(UserActivationToken, verdict.record.id, { used_at: now });
      if (!alreadyActivated) {
        await manager.update(User, user.id, { activated_at: now });
      }

      return {
        activated: true,
        already_activated: alreadyActivated,
        name: user.name,
        email: user.email,
        company_id: user.company_id,
      };
    });

    // Avisar por correo SOLO en la activación de verdad: reenviar el aviso en
    // cada clic repetido convierte un correo útil en ruido.
    if (!result.already_activated) {
      const company = result.company_id
        ? await this.dataSource.getRepository(Company).findOne({ where: { id: result.company_id } })
        : null;

      this.logger.log(`Cuenta activada: ${maskEmail(result.email)}.`);
      // Sin `await`: igual que la bienvenida, el correo no puede hacer esperar
      // ni fallar la activación. La action captura sus propios errores.
      void this.sendAccountActivatedEmailAction.execute({
        customer_name: result.name,
        customer_email: result.email,
        company_name: company?.name ?? '',
      });
    }

    const { company_id: _companyId, ...response } = result;
    return response;
  }
}
