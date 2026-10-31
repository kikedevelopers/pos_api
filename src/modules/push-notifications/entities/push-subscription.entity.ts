import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * `push_subscriptions` — un navegador/dispositivo suscrito a las notificaciones
 * push de la PWA. El `endpoint` lo identifica (único); `p256dh` y `auth` cifran
 * el mensaje para ese navegador.
 */
@Entity('push_subscriptions')
@Index('idx_push_subscriptions_endpoint', ['endpoint'], { unique: true })
export class PushSubscriptionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  /** Negocio en el que estaba al suscribirse. */
  @Column({ type: 'bigint' })
  company_id!: string;

  @Column({ type: 'varchar', length: 20 })
  user_type!: string;

  @Column({ type: 'varchar', length: 20, default: 'user' })
  account!: string;

  @Column({ type: 'text' })
  endpoint!: string;

  @Column({ type: 'varchar', length: 255 })
  p256dh!: string;

  @Column({ type: 'varchar', length: 255 })
  auth!: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  user_agent!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_success_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
