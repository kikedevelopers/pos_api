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
import { Customer } from '@/modules/customers/entities/customer.entity';
import { LoanPlan } from '@/modules/loan-plans/entities/loan-plan.entity';
import {
  LOAN_PLAN_TYPES,
  LOAN_RATE_PERIODS,
  type LoanPlanType,
  type LoanRatePeriod,
} from '@/modules/loan-plans/internal/loan-plan-rules';

export const LOAN_STATUSES = ['active', 'paid', 'cancelled'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const LOAN_SOURCE_TYPES = ['cash_register', 'bank', 'wallet'] as const;
export type LoanSourceType = (typeof LOAN_SOURCE_TYPES)[number];

/**
 * `loans` — Préstamo de dinero a un cliente (modo prestamista). Guarda COPIA de
 * las condiciones del plan con el que se prestó (ver migración 1747012980000).
 * Los `numeric` llegan como string desde Postgres; el DTO los convierte.
 */
@Entity('loans')
@Index('idx_loans_company_status', ['company_id', 'status'])
@Index('idx_loans_company_customer', ['company_id', 'customer_id'])
export class Loan {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint' })
  customer_id!: string;

  @ManyToOne(() => Customer, { onDelete: 'RESTRICT', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

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
