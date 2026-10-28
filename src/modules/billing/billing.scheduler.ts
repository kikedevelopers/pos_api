import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, MoreThan, Not, type Repository } from 'typeorm';

import type { BillingConfig } from '@/config/billing.config';

import { ApplyWompiTransactionAction } from './actions/apply-wompi-transaction.action';
import { PAYMENT_EXPIRE_GRACE_MS, RECONCILE_LOOKBACK_MS } from './billing.constants';
import {
  SubscriptionPayment,
  SubscriptionPaymentStatus,
} from './entities/subscription-payment.entity';

/**
 * Red de seguridad del webhook. Cada 5 minutos:
 *
 *   - promueve el plan de las suscripciones cuyo período YA PAGADO con otro
 *     plan acaba de empezar (renovación con cambio de plan: el anual se
 *     respeta hasta su corte y ahí pasa a mensual);
 *   - vuelve a consultar en Wompi los pagos PENDIENTES que ya conocen su
 *     transacción (PSE/Nequi que tardan, o un webhook que se perdió) y los
 *     aplica con la misma action que el webhook;
 *   - marca `expired` los links que nadie pagó (pasada la gracia de 48 h tras
 *     vencer; aun así, una transacción aprobada que llegue después se aplica).
 *
 * Nunca lanza: un fallo de un pago no frena a los demás (y si era un aprobado,
 * la action ya avisó al operador).
 */
@Injectable()
export class BillingScheduler {
  private readonly logger = new Logger(BillingScheduler.name);
  private running = false;

  constructor(
    private readonly applyTransaction: ApplyWompiTransactionAction,
    private readonly configService: ConfigService,
    @InjectRepository(SubscriptionPayment)
    private readonly paymentsRepo: Repository<SubscriptionPayment>,
  ) {}

  @Cron('*/5 * * * *', { name: 'billing-reconcile-payments' })
  async reconcile(
    now: Date = new Date(),
  ): Promise<{ checked: number; expired: number; promoted: number }> {
    const config = this.configService.getOrThrow<BillingConfig>('billing');
    if (!config.reconcileEnabled || this.running) {
      return { checked: 0, expired: 0, promoted: 0 };
    }
    this.running = true;
    try {
      // No depende de Wompi: los períodos ya están pagados.
      const promoted = await this.promoteStartedPeriods(now).catch((e: unknown) => {
        this.logger.error(
          `Barrido: no se pudo promover planes: ${e instanceof Error ? e.message : String(e)}`,
        );
        return 0;
      });
      if (!config.configured) {
        return { checked: 0, expired: 0, promoted };
      }

      const candidates = await this.paymentsRepo.find({
        where: {
          applied_at: IsNull(),
          status: SubscriptionPaymentStatus.PENDING,
          provider_transaction_id: Not(IsNull()),
          provider_environment: config.environment,
          created_at: MoreThan(new Date(now.getTime() - RECONCILE_LOOKBACK_MS)),
        },
        order: { created_at: 'ASC' },
        take: 100,
      });

      let checked = 0;
      for (const payment of candidates) {
        try {
          await this.applyTransaction.execute(
            payment.provider_transaction_id as string,
            'reconcile',
          );
          checked += 1;
        } catch (e) {
          this.logger.error(
            `Barrido: no se pudo verificar el pago ${payment.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const expired = await this.paymentsRepo.update(
        {
          applied_at: IsNull(),
          status: SubscriptionPaymentStatus.PENDING,
          provider_transaction_id: IsNull(),
          link_expires_at: LessThan(new Date(now.getTime() - PAYMENT_EXPIRE_GRACE_MS)),
        },
        { status: SubscriptionPaymentStatus.EXPIRED },
      );

      return { checked, expired: expired.affected ?? 0, promoted };
    } finally {
      this.running = false;
    }
  }

  /**
   * Pasa `subscriptions.plan` al plan del período pagado que cubre `now`
   * cuando difieren. Solo mira pagos APROBADOS (con días ya cargados), así que
   * nunca asciende un plan que no se pagó. Devuelve cuántas cambió.
   */
  async promoteStartedPeriods(now: Date): Promise<number> {
    // `UPDATE … RETURNING` por `query()` devuelve `[filas, total]`.
    const result: unknown = await this.paymentsRepo.query(
      `
      UPDATE "subscriptions" s
         SET "plan" = cur."plan", "updated_at" = now()
        FROM (
          SELECT DISTINCT ON (p."subscription_id") p."subscription_id", p."plan"
            FROM "subscription_payments" p
           WHERE p."status" = 'approved'
             AND p."period_starts_at" <= $1
             AND p."period_ends_at" > $1
           ORDER BY p."subscription_id", p."period_starts_at" DESC
        ) cur
       WHERE s."id" = cur."subscription_id"
         AND s."plan" <> cur."plan"
      RETURNING s."id", s."company_id", s."plan"
      `,
      [now],
    );
    const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : []) as {
      id: string;
      company_id: string;
      plan: string;
    }[];
    for (const row of rows) {
      this.logger.log({
        event: 'billing.plan_promoted',
        subscriptionId: row.id,
        companyId: row.company_id,
        plan: row.plan,
      });
    }
    return rows.length;
  }
}
