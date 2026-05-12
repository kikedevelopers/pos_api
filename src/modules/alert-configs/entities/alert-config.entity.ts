import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';

/**
 * `alert_configs` — Configuración per-company de cada tipo de alerta.
 *
 * Invariantes:
 *   - `UNIQUE(company_id, type)` — una sola config por (tenant, tipo).
 *   - `type` no puede ser cadena en blanco (CHECK).
 *
 * Esta entidad se persiste y consulta en Fase 10. Los evaluators que
 * leen la `config` jsonb y disparan alertas viven en Fase 11.
 */
@Entity('alert_configs')
@Check('chk_alert_configs_type_not_empty', 'length(btrim(type)) > 0')
export class AlertConfig {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_alert_configs_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'varchar', length: 50 })
  type!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    nullable: true,
    transformer: NumericTransformer,
  })
  threshold!: number | null;

  /**
   * Parámetros del evaluator. Forma libre — los consumidores hacen narrow
   * por `type` antes de leer claves específicas.
   */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  config!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
