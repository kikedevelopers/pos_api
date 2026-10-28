import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { SubscriptionPlan } from '@/modules/subscriptions/entities/subscription.entity';

/**
 * Estado de un pago de suscripción.
 *
 *   - `pending`      — link creado; Wompi todavía no reporta una transacción final.
 *   - `approved`     — transacción APROBADA y verificada; los días YA se cargaron.
 *   - `declined`     — rechazada por el banco/medio de pago.
 *   - `voided`       — anulada.
 *   - `error`        — error del medio de pago.
 *   - `expired`      — nadie pagó el link y venció.
 *   - `needs_review` — Wompi dice APROBADA pero algo no cuadra (monto, moneda,
 *                      link). NO se cargan días y se avisa al operador.
 *
 * Solo `approved` es definitivo. Los demás pueden pasar a `approved` si después
 * llega una transacción aprobada verificada para ese mismo link: si el cliente
 * pagó, los días se cargan, sin importar el orden en que lleguen los eventos.
 */
export enum SubscriptionPaymentStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DECLINED = 'declined',
  VOIDED = 'voided',
  ERROR = 'error',
  EXPIRED = 'expired',
  NEEDS_REVIEW = 'needs_review',
}

/** `subscription_payments` — ver la migración `CreateSubscriptionPayments`. */
@Entity('subscription_payments')
export class SubscriptionPayment {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /** Referencia pública del pago (la que viaja en la URL de regreso). */
  @Column({ type: 'uuid', unique: true })
  reference!: string;

  @Column({ type: 'bigint' })
  company_id!: string;

  @Column({ type: 'bigint' })
  subscription_id!: string;

  @Column({ type: 'bigint' })
  owner_user_id!: string;

  @Column({ type: 'enum', enum: SubscriptionPlan, enumName: 'subscription_plan' })
  plan!: SubscriptionPlan;

  /** Monto cobrado en centavos. `bigint` → string en el driver de pg. */
  @Column({ type: 'bigint' })
  amount_in_cents!: string;

  @Column({ type: 'varchar', length: 3, default: 'COP' })
  currency!: string;

  @Column({ type: 'integer' })
  days_granted!: number;

  @Column({ type: 'varchar', length: 20, default: 'wompi' })
  provider!: string;

  @Column({ type: 'varchar', length: 20 })
  provider_environment!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  payment_link_id!: string;

  @Column({ type: 'text' })
  checkout_url!: string;

  @Column({ type: 'timestamptz' })
  link_expires_at!: Date;

  @Column({
    type: 'enum',
    enum: SubscriptionPaymentStatus,
    enumName: 'subscription_payment_status',
    default: SubscriptionPaymentStatus.PENDING,
  })
  status!: SubscriptionPaymentStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  provider_transaction_id!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  provider_status!: string | null;

  @Column({ type: 'text', nullable: true })
  provider_status_message!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  payment_method_type!: string | null;

  @Column({ type: 'text', nullable: true })
  failure_reason!: string | null;

  /** Cuándo se cargaron los días. `approved` ⇔ NOT NULL (CHECK en la BD). */
  @Column({ type: 'timestamptz', nullable: true })
  applied_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  period_starts_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  period_ends_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_checked_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
