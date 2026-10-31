import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { AccountKind, AuthUser, UserType } from '@/common/types/jwt-payload.type';
import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import { PERMISSION_KEYS } from '@/modules/roles/internal/permission-catalog';

import type { SavePushSubscriptionDto } from './dto/push-subscription.dto';
import { PushSubscriptionEntity } from './entities/push-subscription.entity';
import {
  buildAgentOrderPush,
  isGoneSubscription,
  type AgentOrderPush,
} from './internal/push-message';
import { WebPushSender } from './internal/web-push.sender';

/** Suscripción candidata a un aviso, con si es dueño del negocio del evento. */
interface AudienceRow {
  id: string;
  user_id: string;
  company_id: string;
  user_type: UserType;
  account: AccountKind;
  endpoint: string;
  p256dh: string;
  auth: string;
  is_owner: boolean;
}

/**
 * Notificaciones push de la PWA. Guarda las suscripciones de cada dispositivo y
 * envía los avisos de los pedidos del agente al MISMO público que los ve en la
 * campana:
 *   - quien está en ese negocio con nivel administrador, y
 *   - el DUEÑO, aunque esté parado en otra de sus sucursales.
 * Todo es best-effort: un envío fallido nunca rompe la operación del pedido.
 */
@Injectable()
export class PushNotificationsService {
  private readonly logger = new Logger(PushNotificationsService.name);

  constructor(
    @InjectRepository(PushSubscriptionEntity)
    private readonly repo: Repository<PushSubscriptionEntity>,
    private readonly sender: WebPushSender,
    private readonly permissions: ResolveEffectivePermissionsAction,
  ) {}

  /** Lo que la PWA necesita para suscribirse (`enabled: false` = no ofrecerlo). */
  publicKey(): { enabled: boolean; public_key: string | null } {
    return this.sender.enabled
      ? { enabled: true, public_key: this.sender.publicKey }
      : { enabled: false, public_key: null };
  }

  /**
   * Guarda (o reasigna) la suscripción de este dispositivo. El endpoint es
   * único: si el mismo navegador entra con otra cuenta o en otro negocio, la
   * fila pasa a ser de quien la registró último.
   */
  async subscribe(user: AuthUser, companyId: number, dto: SavePushSubscriptionDto): Promise<void> {
    await this.repo.query(
      `INSERT INTO push_subscriptions
         (user_id, company_id, user_type, account, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         company_id = EXCLUDED.company_id,
         user_type = EXCLUDED.user_type,
         account = EXCLUDED.account,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         updated_at = now()`,
      [
        user.user_id,
        companyId,
        user.type,
        user.account ?? 'user',
        dto.endpoint,
        dto.keys.p256dh,
        dto.keys.auth,
        dto.user_agent?.slice(0, 300) ?? null,
      ],
    );
  }

  /** Quita la suscripción de este dispositivo (solo si es del usuario). */
  async unsubscribe(user: AuthUser, endpoint: string): Promise<void> {
    await this.repo.delete({ endpoint, user_id: String(user.user_id) });
  }

  /** Avisa un evento de un pedido del agente a quien corresponde. */
  async notifyAgentOrder(event: AgentOrderPush): Promise<void> {
    if (!this.sender.enabled) {
      return;
    }
    try {
      const audience = await this.audience(event.company_id);
      await Promise.all(
        audience.map((row) =>
          this.deliver(row, JSON.stringify(buildAgentOrderPush(event, Number(row.company_id)))),
        ),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, companyId: event.company_id },
        'No pude enviar las notificaciones push del pedido.',
      );
    }
  }

  /**
   * Suscripciones a las que les toca el aviso: las del negocio con nivel
   * administrador y las de sus dueños activos (estén en el negocio que estén).
   */
  private async audience(companyId: number): Promise<AudienceRow[]> {
    const rows = await this.repo.query<AudienceRow[]>(
      `SELECT ps.id, ps.user_id, ps.company_id, ps.user_type, ps.account,
              ps.endpoint, ps.p256dh, ps.auth,
              (cm.user_id IS NOT NULL) AS is_owner
         FROM push_subscriptions ps
         LEFT JOIN company_members cm
           ON cm.user_id = ps.user_id
          AND cm.company_id = $1
          AND cm.role = 'owner'
          AND cm.is_active = true
        WHERE ps.company_id = $1 OR cm.user_id IS NOT NULL`,
      [companyId],
    );
    const adminByUser = new Map<string, boolean>();
    const allowed: AudienceRow[] = [];
    for (const row of rows) {
      if (row.is_owner) {
        allowed.push(row);
        continue;
      }
      if (Number(row.company_id) !== companyId) {
        continue;
      }
      let isAdmin = adminByUser.get(row.user_id);
      if (isAdmin === undefined) {
        const granted = new Set<string>(
          await this.permissions.execute({
            type: row.user_type,
            account: row.account,
            user_id: Number(row.user_id),
            company_id: companyId,
          }),
        );
        isAdmin = PERMISSION_KEYS.every((key) => granted.has(key));
        adminByUser.set(row.user_id, isAdmin);
      }
      if (isAdmin) {
        allowed.push(row);
      }
    }
    return allowed;
  }

  private async deliver(row: AudienceRow, payload: string): Promise<void> {
    try {
      await this.sender.send(row, payload);
      await this.repo.update({ id: row.id }, { last_success_at: new Date() });
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (isGoneSubscription(statusCode)) {
        await this.repo.delete({ id: row.id });
        return;
      }
      this.logger.warn({ err: error, subscriptionId: row.id }, 'Falló un envío push.');
    }
  }
}
