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

import { Company } from '@/modules/companies/entities/company.entity';

import {
  LOAN_PLAN_TYPES,
  LOAN_RATE_PERIODS,
  type LoanPlanType,
  type LoanRatePeriod,
} from '../internal/loan-plan-rules';

/**
 * `loan_plans` — Plan de préstamo de un PRESTAMISTA: la plantilla (tipo,
 * tasa, periodo, cuotas, días de cobro) que se elige al prestar para no
 * configurar cada préstamo a mano.
 *
 * Multi-tenancy: toda query filtra por `company_id` (del JWT). UNIQUE
 * per-company parcial sobre `lower(btrim(name))` donde `is_archived = false`
 * (archivar libera el nombre). Los planes se archivan, no se borran: los
 * préstamos que se hagan con un plan deben poder seguir nombrándolo.
 *
 * `interest_rate` es `numeric(7,4)`: TypeORM lo devuelve como string; el DTO de
 * respuesta lo convierte a número.
 */
@Entity('loan_plans')
@Check('chk_loan_plans_name_not_empty', 'length(btrim(name)) > 0')
export class LoanPlan {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_loan_plans_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text', nullable: false })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'enum', enum: LOAN_PLAN_TYPES, enumName: 'loan_plans_plan_type_enum' })
  plan_type!: LoanPlanType;

  @Column({ type: 'numeric', precision: 7, scale: 4 })
  interest_rate!: string;

  @Column({ type: 'enum', enum: LOAN_RATE_PERIODS, enumName: 'loan_plans_rate_period_enum' })
  rate_period!: LoanRatePeriod;

  @Column({ type: 'integer', nullable: true })
  installments_count!: number | null;

  @Column({ type: 'integer', nullable: true })
  collection_days!: number | null;

  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  /** Snapshot del full_name del actor que creó el plan. */
  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  /** ID del actor creador. Sin FK formal — informacional. */
  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
