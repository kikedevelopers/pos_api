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
 * Unidad de periodicidad para el corte (paridad PlacePos
 * `FixedExpensePeriodUnit`).
 */
export type FixedExpensePeriodUnit = 'hour' | 'day' | 'week' | 'month';

export const FIXED_EXPENSE_PERIOD_UNITS: readonly FixedExpensePeriodUnit[] = [
  'hour',
  'day',
  'week',
  'month',
] as const;

/**
 * `fixed_expenses` — Gasto recurrente programado de una company.
 *
 * Espejo de `placepos/src/main/database/entities/FixedExpense.ts` con
 * extensión multi-tenant (`company_id` NOT NULL, FK e índice).
 *
 * Modelo de negocio:
 *   - El usuario configura un gasto recurrente (ej. "alquiler $500 cada
 *     1 mes desde el 2026-01-01").
 *   - Un job/scheduler crea `fixed_expense_periods` cuando se vencen
 *     (función de sincronización fuera del alcance de este módulo).
 *   - Cada periodo pendiente puede marcarse como pagado (registrando
 *     `Expense` real + `FinancialMovement` en la action correspondiente
 *     — eso es trabajo futuro; aquí solo modelamos el catálogo).
 *
 * Soft-delete: `is_archived` (paridad PlacePos). NO `is_deleted`.
 *
 * Side effects: cuando se crea o se edita `start_date`/`period_*`, el
 * scheduler debe re-sincronizar cortes. En la implementación cloud, el
 * sync se ejecuta lazy en cada GET (paridad parcial con PlacePos) +
 * forzado tras POST/PUT — TODO en una Fase posterior cuando el scheduler
 * exista. Por ahora, los periodos se crean manualmente desde otra action.
 */
@Entity('fixed_expenses')
@Check('chk_fixed_expenses_period_unit', `period_unit IN ('hour','day','week','month')`)
@Check('chk_fixed_expenses_period_quantity_positive', 'period_quantity > 0')
@Check('chk_fixed_expenses_amount_nonneg', 'amount >= 0')
export class FixedExpense {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_fixed_expenses_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text', nullable: false })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  @Column({ type: 'text', nullable: false })
  period_unit!: FixedExpensePeriodUnit;

  @Column({ type: 'integer', nullable: false })
  period_quantity!: number;

  @Column({ type: 'timestamptz', nullable: false })
  start_date!: Date;

  @Column({ type: 'boolean', nullable: false, default: false })
  is_archived!: boolean;

  @Column({ type: 'text', nullable: false })
  created_by!: string;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
