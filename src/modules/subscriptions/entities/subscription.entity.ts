import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Plan contratado. `free` es la prueba inicial: una cuenta recién registrada
 * SIEMPRE tiene plan, nunca "ninguno" — así el portal siempre tiene algo que
 * pintar y no hay que tratar el null como un cuarto estado.
 */
export enum SubscriptionPlan {
  FREE = 'free',
  MONTHLY = 'monthly',
  ANNUAL = 'annual',
}

/**
 * Estado del COBRO. Ojo: no es el estado de la vigencia — esa se deriva de
 * `expires_at`, que sigue siendo la única fuente de la verdad del bloqueo.
 * `status` responde "por qué", `expires_at` responde "hasta cuándo".
 *
 *   - `trialing`        — en la prueba gratuita.
 *   - `active`          — plan de pago vigente y pagado.
 *   - `payment_pending` — el dueño pidió un plan y el pago no se ha procesado.
 *   - `payment_failed`  — el último intento de cobro falló.
 *   - `canceled`        — el dueño canceló; corre hasta `expires_at` y no renueva.
 */
export enum SubscriptionStatus {
  TRIALING = 'trialing',
  ACTIVE = 'active',
  PAYMENT_PENDING = 'payment_pending',
  PAYMENT_FAILED = 'payment_failed',
  CANCELED = 'canceled',
}

/**
 * `subscriptions` — Suscripción POR EMPRESA (cloud-only).
 *
 * Regla de negocio:
 *   - Al registrarse un owner se crea su fila con `started_at = now()` y
 *     `expires_at = now() + SUBSCRIPTION_TRIAL_DAYS días` (trial de gracia).
 *   - Cuando `expires_at < now()` la app se BLOQUEA POR COMPLETO para TODOS
 *     los usuarios de esa company (owner/manager/employee): ni login ni
 *     lectura ni escritura. El bloqueo lo aplica `SubscriptionGuard` (rutas
 *     protegidas) y `LoginAction` (login).
 *   - Superadmin (`company_id` null) NUNCA se bloquea.
 *   - NO se implementa renovación todavía.
 *
 * --------------------------------------------------------------------------
 * Invariantes
 * --------------------------------------------------------------------------
 *
 *   - `company_id` UNIQUE — una sola suscripción por company.
 *   - `expires_at` indexado — el guard consulta vigencia por company y el
 *     barrido de vencidas podrá filtrar por esta columna.
 */
@Entity('subscriptions')
export class Subscription {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /**
   * Tenant dueño de la suscripción. UNIQUE: una sola fila por company.
   */
  @Index('idx_subscriptions_company_id_unique', { unique: true })
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /**
   * Owner que originó la suscripción (el user creado en el registro). Se
   * preserva por trazabilidad; el bloqueo aplica a TODA la company, no solo
   * al owner.
   */
  @Column({ type: 'bigint', nullable: false })
  owner_user_id!: string;

  @ManyToOne(() => User, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'owner_user_id' })
  owner_user!: User;

  @Column({ type: 'timestamptz', nullable: false })
  started_at!: Date;

  @Index('idx_subscriptions_expires_at')
  @Column({ type: 'timestamptz', nullable: false })
  expires_at!: Date;

  /** Plan vigente. Ver {@link SubscriptionPlan}. */
  @Column({
    type: 'enum',
    enum: SubscriptionPlan,
    enumName: 'subscription_plan',
    nullable: false,
    default: SubscriptionPlan.FREE,
  })
  plan!: SubscriptionPlan;

  /** Estado del cobro. Ver {@link SubscriptionStatus}. */
  @Index('idx_subscriptions_status')
  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    enumName: 'subscription_status',
    nullable: false,
    default: SubscriptionStatus.TRIALING,
  })
  status!: SubscriptionStatus;

  /**
   * Plan solicitado y todavía sin pagar. `null` = no hay nada pendiente.
   *
   * Separado de `plan` a propósito: pedir un plan no es tenerlo. Cuando entre
   * la pasarela, es este campo el que la confirmación del pago promueve a
   * `plan`.
   */
  @Column({
    type: 'enum',
    enum: SubscriptionPlan,
    enumName: 'subscription_plan',
    nullable: true,
  })
  requested_plan!: SubscriptionPlan | null;

  /** Cuándo se pidió `requested_plan`. Sirve para caducar solicitudes viejas. */
  @Column({ type: 'timestamptz', nullable: true })
  plan_requested_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
