import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Subscription } from '../entities/subscription.entity';
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
}

@Injectable()
export class CreateSubscriptionAction {
  private readonly logger = new Logger(CreateSubscriptionAction.name);

  async execute(manager: EntityManager, input: CreateSubscriptionInput): Promise<Subscription> {
    const repo = manager.getRepository(Subscription);

    const startedAt = input.startedAt;
    const expiresAt = addDays(startedAt, SUBSCRIPTION_TRIAL_DAYS);

    const subscription = repo.create({
      company_id: String(input.companyId),
      owner_user_id: String(input.ownerUserId),
      started_at: startedAt,
      expires_at: expiresAt,
    });
    const saved = await repo.save(subscription);

    this.logger.log({
      event: 'subscription.created',
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
      startedAt: startedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      trialDays: SUBSCRIPTION_TRIAL_DAYS,
    });

    return saved;
  }
}
