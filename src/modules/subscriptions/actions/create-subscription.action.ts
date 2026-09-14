import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import {
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../entities/subscription.entity';
import { addDays, SUBSCRIPTION_TRIAL_DAYS } from '../subscriptions.constants';

/**
 * Crea la suscripción inicial (trial) de una company recién registrada.
 *
 * `expires_at = startedAt + SUBSCRIPTION_TRIAL_DAYS días`.
 *
 * Diseñada para ejecutarse DENTRO de la transacción del `RegisterAction` —
 * exige el `manager` para forzar atomicidad. Si el registro falla en cualquier
 * paso posterior, la suscripción se revierte junto con Company + User + seeds.
 */
export interface CreateSubscriptionInput {
  companyId: number;
  ownerUserId: number;
  startedAt: Date;
  /**
   * Duración (en días) de la ventana de vigencia del trial. Opcional: si se
   * omite se usa `SUBSCRIPTION_TRIAL_DAYS` (10), que es el registro normal.
   * El flujo de migración desde un POS offline pasa
   * `SUBSCRIPTION_MIGRATION_DAYS` (1).
   */
  durationDays?: number;
}

@Injectable()
export class CreateSubscriptionAction {
  private readonly logger = new Logger(CreateSubscriptionAction.name);

  async execute(manager: EntityManager, input: CreateSubscriptionInput): Promise<Subscription> {
    const repo = manager.getRepository(Subscription);

    const startedAt = input.startedAt;
    const durationDays = input.durationDays ?? SUBSCRIPTION_TRIAL_DAYS;
    const expiresAt = addDays(startedAt, durationDays);

    const subscription = repo.create({
      company_id: String(input.companyId),
      owner_user_id: String(input.ownerUserId),
      started_at: startedAt,
      expires_at: expiresAt,
      // Explícitos aunque la columna tenga DEFAULT: TypeORM 0.3 no aplica el
      // default SQL si el campo no aparece en `create()` — escribiría NULL en
      // una columna NOT NULL y el registro entero fallaría.
      plan: SubscriptionPlan.FREE,
      status: SubscriptionStatus.TRIALING,
      requested_plan: null,
      plan_requested_at: null,
    });
    const saved = await repo.save(subscription);

    this.logger.log({
      event: 'subscription.created',
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
      startedAt: startedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      trialDays: durationDays,
    });

    return saved;
  }
}
