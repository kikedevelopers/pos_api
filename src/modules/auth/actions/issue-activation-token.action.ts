import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { UserActivationToken } from '../entities/user-activation-token.entity';
import {
  activationExpiresAt,
  generateActivationToken,
  hashActivationToken,
} from '../internal/activation-token';

export interface IssuedActivationToken {
  /** Token EN CLARO. Solo viaja al correo; no se persiste ni se loguea. */
  token: string;
  expiresAt: Date;
}

/**
 * Emite un token de activación para un usuario.
 *
 * Invalida los anteriores del mismo usuario marcándolos como usados: si se
 * reenvía el correo, el enlace viejo deja de servir. Un enlace de activación
 * vivo es una credencial, y no tiene sentido tener varias sueltas.
 */
@Injectable()
export class IssueActivationTokenAction {
  async execute(
    manager: EntityManager,
    userId: string | number,
    now: Date = new Date(),
  ): Promise<IssuedActivationToken> {
    const token = generateActivationToken();
    const expiresAt = activationExpiresAt(now);

    await manager
      .createQueryBuilder()
      .update(UserActivationToken)
      .set({ used_at: now })
      .where('user_id = :userId AND used_at IS NULL', { userId: String(userId) })
      .execute();

    await manager.save(
      manager.create(UserActivationToken, {
        user_id: String(userId),
        token_hash: hashActivationToken(token),
        expires_at: expiresAt,
        used_at: null,
      }),
    );

    return { token, expiresAt };
  }
}
