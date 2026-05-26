import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Subscription } from './entities/subscription.entity';

/**
 * Facade del módulo `subscriptions`. Expone la consulta de la suscripción por
 * company, consumida por:
 *   - `SubscriptionGuard` (bloqueo de rutas protegidas).
 *   - `LoginAction`        (bloqueo de login).
 *   - `SubscriptionsController` (GET /subscription).
 *
 * Lógica mínima: el lookup es una query indexada por `company_id` (UNIQUE).
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectRepository(Subscription)
    private readonly repo: Repository<Subscription>,
  ) {}

  /**
   * Devuelve la suscripción de la company o `null` si no existe.
   * Lookup por índice UNIQUE `idx_subscriptions_company_id_unique`.
   */
  findByCompany(companyId: number): Promise<Subscription | null> {
    return this.repo.findOne({ where: { company_id: String(companyId) } });
  }
}
