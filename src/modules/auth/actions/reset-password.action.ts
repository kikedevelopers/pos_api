import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';
import { SendPasswordChangedEmailAction } from '@/modules/mail/actions/send-password-changed-email.action';
import { maskEmail } from '@/modules/mail/internal/mail-address';
import { User } from '@/modules/users/entities/user.entity';

import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { describePasswordFailure, isValidPassword } from '../internal/password-policy';
import {
  describePasswordResetRejection,
  evaluatePasswordResetToken,
  hashPasswordResetToken,
  looksLikePasswordResetToken,
} from '../internal/password-reset-token';

export interface ResetPasswordResult {
  updated: boolean;
  /** Enmascarada: confirma de qué cuenta se cambió sin exponerla entera. */
  email: string;
}

/**
 * Cambia la contraseña con el token del correo.
 *
 * Las reglas son las MISMAS que al registrarse y se aplican aquí, en el
 * servidor: una validación que solo vive en el cliente es una sugerencia.
 */
@Injectable()
export class ResetPasswordAction {
  private readonly logger = new Logger(ResetPasswordAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly sendPasswordChangedEmailAction: SendPasswordChangedEmailAction,
  ) {}

  async execute(rawToken: string, password: string): Promise<ResetPasswordResult> {
    const token = rawToken.trim();
    if (!looksLikePasswordResetToken(token)) {
      throw new BadRequestException({
        message: describePasswordResetRejection('invalid'),
        payload: { code: 'RESET_TOKEN_INVALID' },
      });
    }

    if (!isValidPassword(password)) {
      throw new BadRequestException({
        message: describePasswordFailure(password),
        payload: { code: 'PASSWORD_POLICY' },
      });
    }

    // El hash se calcula FUERA de la transacción: argon2 tarda ~100 ms y
    // mantener abierta una conexión esperándolo bloquea el pool.
    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
    const tokenHash = hashPasswordResetToken(token);
    const now = new Date();

    const email = await this.dataSource.transaction<string>(async (manager) => {
      // `FOR UPDATE`: dos envíos simultáneos del formulario no pueden canjear
      // el mismo token dos veces.
      const record = await manager
        .createQueryBuilder(PasswordResetToken, 'token')
        .setLock('pessimistic_write')
        .where('token.token_hash = :tokenHash', { tokenHash })
        .getOne();

      const verdict = evaluatePasswordResetToken(record, now);
      if (!verdict.valid) {
        throw new BadRequestException({
          message: describePasswordResetRejection(verdict.reason),
          payload: { code: `RESET_TOKEN_${verdict.reason.toUpperCase()}` },
        });
      }

      const user = await manager.findOne(User, { where: { id: verdict.record.user_id } });
      if (!user) {
        throw new BadRequestException({
          message: describePasswordResetRejection('invalid'),
          payload: { code: 'RESET_TOKEN_INVALID' },
        });
      }

      await manager.update(PasswordResetToken, verdict.record.id, { used_at: now });
      await manager.update(User, user.id, { password: passwordHash });

      return user.email;
    });

    this.logger.log(`Contraseña actualizada para ${maskEmail(email)}.`);

    // Aviso SIN esperar: la contraseña ya cambió, y un proveedor de correo
    // lento o caído no puede convertir un cambio exitoso en un error. La action
    // captura sus propios fallos.
    void this.sendPasswordChangedEmailAction.execute({ customer_email: email });

    return { updated: true, email: maskEmail(email) };
  }
}
