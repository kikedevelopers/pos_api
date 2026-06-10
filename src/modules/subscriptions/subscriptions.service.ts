import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Subscription } from './entities/subscription.entity';

/**
 * Facade del módulo `subscriptions`. Expone la consulta de la suscripción
 * APLICABLE a una company, consumida por:
 *   - `SubscriptionGuard` (bloqueo de rutas protegidas).
 *   - `LoginAction`        (bloqueo de login).
 *   - `SubscriptionsController` (GET /subscription).
 *
 * Multi-sucursal: la suscripción de vigencia es ÚNICA por owner y vive en su
 * negocio principal. Las sucursales NO tienen suscripción propia: comparten la
 * del principal. Por eso el lookup no es por `company_id` directo, sino por el
 * OWNER de la company (principal o sucursal). Si la del principal vence, se
 * bloquean todas las companies del owner.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectRepository(Subscription)
    private readonly repo: Repository<Subscription>,
  ) {}

  /**
   * Devuelve la suscripción aplicable a `companyId` (principal o sucursal) o
   * `null` si no existe.
   *
   * Resolución: vía `company_members` se obtiene el owner de la company del
   * JWT; la suscripción vive en la company PRINCIPAL del owner
   * (`users.company_id`, donde `s.company_id` coincide). Una sola query con
   * joins por nombre de tabla (no acopla este módulo a otras entidades).
   */
  findApplicable(companyId: number): Promise<Subscription | null> {
    return this.repo
      .createQueryBuilder('s')
      .innerJoin('users', 'u', 'u.company_id = s.company_id AND u.type = :ownerType', {
        ownerType: 'owner',
      })
      .innerJoin('company_members', 'cm', 'cm.user_id = u.id AND cm.role = :memberRole', {
        memberRole: 'owner',
      })
      .where('cm.company_id = :companyId', { companyId: String(companyId) })
      .getOne();
  }
}
