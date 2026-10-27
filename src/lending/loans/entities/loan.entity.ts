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

import { LoanPlan } from '@/lending/loan-plans/entities/loan-plan.entity';
import {
  DISBURSEMENT_SOURCE_TYPES,
  type DisbursementSourceType,
} from '@/lending/ports/lending-treasury.port';
import {
  LOAN_PLAN_TYPES,
  LOAN_RATE_PERIODS,
  type LoanPlanType,
  type LoanRatePeriod,
} from '@/lending/domain/loan-plan-rules';

export const LOAN_STATUSES = ['active', 'paid', 'cancelled'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const LOAN_SOURCE_TYPES = DISBURSEMENT_SOURCE_TYPES;
export type LoanSourceType = DisbursementSourceType;

/**
 * `loans` — Préstamo de dinero a un cliente (modo prestamista). Guarda COPIA de
 * las condiciones del plan con el que se prestó (ver migración 1747012980000).
 * La única relación TypeORM es con su plan (mismo contexto de préstamos).
 * Los `numeric` llegan como string desde Postgres; el DTO los convierte.
 */
@Entity('loans')
@Index('idx_loans_company_status', ['company_id', 'status'])
@Index('idx_loans_company_customer', ['company_id', 'customer_id'])
export class Loan {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /**
   * Tenant y cliente: las FKs (`companies` CASCADE, `customers` RESTRICT)
   * existen en la base, pero sin relación TypeORM a propósito: préstamos no
   * depende de entidades del POS. El nombre del cliente se pide al puerto de
   * clientes.
   */
  @Column({ type: 'bigint' })
  company_id!: string;

  @Column({ type: 'bigint' })
  customer_id!: string;

  @Column({ type: 'bigint', nullable: true })
  loan_plan_id!: string | null;

  @ManyToOne(() => LoanPlan, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'loan_plan_id' })
  loan_plan!: LoanPlan | null;

  @Column({ type: 'text' })
  plan_name!: string;

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

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  principal!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  outstanding_principal!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  installment_amount!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  daily_amount!: string | null;

  /** `date` (YYYY-MM-DD, día del negocio): sin hora ni zona. */
  @Column({ type: 'date' })
  start_date!: string;

  @Column({ type: 'enum', enum: LOAN_STATUSES, enumName: 'loans_status_enum', default: 'active' })
  status!: LoanStatus;

  @Column({ type: 'text' })
  source_type!: LoanSourceType;

  @Column({ type: 'bigint' })
  source_id!: string;

  @Column({ type: 'text' })
  source_name!: string;

  @Column({ type: 'text' })
  reference_code!: string;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
