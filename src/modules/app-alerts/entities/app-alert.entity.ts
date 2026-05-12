import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

/**
 * Severidad de la alerta. Coincide con el enum nativo
 * `alert_severity` declarado en la migración 1747009140000.
 */
export enum AlertSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

/**
 * `app_alerts` — Notificaciones generadas por el sistema (low_stock,
 * break_even alcanzado, cliente inactivo, etc.).
 *
 * Espejo de `AppAlert.ts` PlacePos con campos adicionales para el cloud:
 *   - `company_id` NOT NULL para multi-tenancy.
 *   - `severity` (alert_severity) para UI badges.
 *   - `title` / `message` text pre-renderizados (PlacePos sólo guarda
 *     `payload` jsonb y el frontend renderiza por tipo). Mantenerlo
 *     pre-renderizado simplifica el front-end y permite buscar por texto.
 *
 * Esta fase NO crea ni evalúa alertas — los evaluators viven en Fase 11.
 * Aquí solo se expone el CRUD básico y la marca de leídas.
 */
@Entity('app_alerts')
@Check('chk_app_alerts_title_not_empty', 'length(btrim(title)) > 0')
@Check('chk_app_alerts_message_not_empty', 'length(btrim(message)) > 0')
export class AppAlert {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_app_alerts_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /**
   * Identificador del tipo de alerta (ej. `low_stock`, `break_even_reached`,
   * `inactive_customer`). Se trata como string-enum para que crecer no
   * requiera migración Postgres.
   */
  @Column({ type: 'varchar', length: 50 })
  type!: string;

  @Column({
    type: 'enum',
    enum: AlertSeverity,
    enumName: 'alert_severity',
    default: AlertSeverity.INFO,
  })
  severity!: AlertSeverity;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'boolean', default: false })
  is_read!: boolean;

  /**
   * Payload tipado por `type`. El consumidor debe hacer narrow por `type`
   * antes de leer claves específicas. Espejo de `AppAlert.payload` PlacePos.
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
