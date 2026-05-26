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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
