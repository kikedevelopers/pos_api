import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';

import { FixedExpense } from './fixed-expense.entity';

/**
 * Estado de un corte de gasto fijo. Paridad PlacePos.
 *
 * - `PENDING`        — sin pagos (paid_amount = 0).
 * - `PARTIALLY_PAID` — pago parcial (paid_amount > 0 AND balance > 0).
 * - `PAID`           — saldado (balance = 0).
 */
export type FixedExpensePeriodStatus = 'PENDING' | 'PARTIALLY_PAID' | 'PAID';

export const FIXED_EXPENSE_PERIOD_STATUSES: readonly FixedExpensePeriodStatus[] = [
  'PENDING',
  'PARTIALLY_PAID',
  'PAID',
] as const;

/**
 * `fixed_expense_periods` — Corte vencido de un FixedExpense.
 *
 * Espejo de `placepos/src/main/database/entities/FixedExpensePeriod.ts`,
 * extendido con `company_id` denormalizado para multi-tenant.
 *
 * --------------------------------------------------------------------------
 * Por qué `company_id` en el periodo (denormalizado vs. solo en
 * `fixed_expense_id`)
 * --------------------------------------------------------------------------
 *
 * El gasto fijo padre ya garantiza el tenant. Sin embargo:
 *
 *   1. Listados por company filtran SOLO esta tabla (sin JOIN). Tener
 *      `company_id` aquí permite usar el índice parcial directamente.
 *   2. Defensa contra IDOR: aunque el action filtre `fixed_expense_id` por
 *      `company_id`, una query mal escrita en otro flujo (audit log,
 *      reporting) podría leer cortes cross-tenant. Bloqueamos en DB:
 *      filtros por `company_id` siempre disponibles.
 *   3. CHECK constraint a futuro: `company_id` del periodo debe coincidir
 *      con el del padre — agregable como trigger sin migrar datos.
 *
 * --------------------------------------------------------------------------
 * Constraints e índices
 * --------------------------------------------------------------------------
 *
 *   - UNIQUE `(fixed_expense_id, period_number)` — idempotencia del sync.
 *     Si el scheduler corre dos veces para el mismo corte, el segundo INSERT
 *     falla limpio.
 *   - Index `(fixed_expense_id, status)` — listado típico: cortes pendientes
 *     por gasto.
 *   - Index `(company_id, status, due_at DESC)` — feed cross-gasto para
 *     "qué le debo a quién esta semana".
 */
@Entity('fixed_expense_periods')
@Unique('UQ_fixed_expense_periods_expense_number', ['fixed_expense_id', 'period_number'])
@Check('chk_fixed_expense_periods_status', `status IN ('PENDING','PARTIALLY_PAID','PAID')`)
@Check('chk_fixed_expense_periods_period_number_positive', 'period_number > 0')
@Check('chk_fixed_expense_periods_amount_nonneg', 'amount >= 0')
@Check('chk_fixed_expense_periods_paid_amount_nonneg', 'paid_amount >= 0')
@Check('chk_fixed_expense_periods_balance_nonneg', 'balance >= 0')
@Check('chk_fixed_expense_periods_paid_plus_balance', 'paid_amount + balance = amount')
@Check(
  'chk_fixed_expense_periods_status_consistency',
  `(status = 'PENDING' AND paid_amount = 0)
   OR (status = 'PARTIALLY_PAID' AND paid_amount > 0 AND balance > 0)
   OR (status = 'PAID' AND balance = 0)`,
)
export class FixedExpensePeriod {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_fixed_expense_periods_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Index('idx_fixed_expense_periods_pending', { synchronize: false })
  @Column({ type: 'bigint', nullable: false })
  fixed_expense_id!: string;

  @ManyToOne(() => FixedExpense, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'fixed_expense_id' })
  fixed_expense!: FixedExpense;

  /**
   * Número secuencial 1..N del corte. Paridad PlacePos:
   * `n = floor(elapsed / period_hours)` — calculado por el sync.
   */
  @Column({ type: 'integer', nullable: false })
  period_number!: number;

  /** Instante de vencimiento del corte (`start_date + n * period`). */
  @Column({ type: 'timestamptz', nullable: false })
  due_at!: Date;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  /** Monto acumulado pagado del corte (Big.js en la lógica de pago). */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  paid_amount!: number;

  /** Saldo restante del corte. En el sync se setea = amount al crear el corte. */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  balance!: number;

  @Column({ type: 'text', nullable: false, default: 'PENDING' })
  status!: FixedExpensePeriodStatus;

  /**
   * Alerta opcional generada en `app_alerts` para este corte. Nullable
   * porque la sincronización podría fallar a mitad de transacción. Si la
   * alerta se borra, este campo queda NULL (`ON DELETE SET NULL`).
   */
  @Column({ type: 'bigint', nullable: true })
  alert_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  paid_by_id!: string | null;

  /**
   * `Expense` materializado al marcar el corte como pagado. NULL para cortes
   * antiguos que se marcaron PAID antes de I-3 (back-compat).
   */
  @Column({ type: 'bigint', nullable: true })
  expense_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
