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
 * Fuente de un gasto. Espeja `ExpenseSourceType` de PlacePos validado por
 * CHECK constraint en la migración 1747009680000.
 */
export type ExpenseSourceType = 'bank' | 'wallet' | 'cash_register';

/**
 * Categoría libre. PlacePos NO usa enum nativo — guarda texto libre (uno de
 * SUPPLIES, RENT, UTILITIES, SALARY, OTHER). Mantenemos string union para
 * documentar valores esperados sin restringir en DB (forward-compat).
 */
export const EXPENSE_CATEGORIES = ['SUPPLIES', 'RENT', 'UTILITIES', 'SALARY', 'OTHER'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * `expenses` — Gasto administrativo de una company.
 *
 * Espejo de `placepos/src/main/database/entities/Expense.ts` con extensión
 * multi-tenant (`company_id` NOT NULL).
 *
 * --------------------------------------------------------------------------
 * Soft-delete
 * --------------------------------------------------------------------------
 *
 *   Convención PlacePos: `is_archived` (NO `is_deleted`). Cuando se anula un
 *   gasto, se marca `is_archived = true` y se revierte el balance de la
 *   fuente. Los gastos archivados se devuelven en `GET /expenses` (campo
 *   visible en el frontend) pero no cuentan para el total agregado.
 *
 * --------------------------------------------------------------------------
 * Invariantes
 * --------------------------------------------------------------------------
 *
 *   - `amount > 0` (CHECK).
 *   - `description` no-blank (CHECK).
 *   - `source_type IN ('bank', 'wallet', 'cash_register')` (CHECK).
 *   - `source_id` NOT NULL — siempre se conoce la fuente.
 *   - `(source_type, source_id)` debe pertenecer a la misma `company_id`
 *     (validado por la action, no por DB CHECK).
 *
 * Side effects al INSERT (orquestados por `CreateExpenseAction`):
 *
 *   1. Lock pessimistic_write sobre la cuenta origen.
 *   2. Validar balance suficiente.
 *   3. Debitar balance (UPDATE Bank/Wallet, o INSERT CashRegisterLog OUT).
 *   4. INSERT Expense.
 *   5. INSERT FinancialMovement(EXPENSE, concept=EXPENSE).
 *
 * Side effects al VOID (orquestados por `VoidExpenseAction`):
 *
 *   1. Lock pessimistic_write sobre la cuenta origen (validar que sigue
 *      activa).
 *   2. UPDATE Expense SET is_archived = true.
 *   3. Acreditar balance (revertir).
 *   4. INSERT FinancialMovement(INCOME, concept=ADJUSTMENT) — concept
 *      reversal.
 */
@Entity('expenses')
@Check('chk_expenses_amount_positive', 'amount > 0')
@Check('chk_expenses_description_not_empty', 'length(btrim(description)) > 0')
@Check('chk_expenses_source_type_values', `source_type IN ('bank', 'wallet', 'cash_register')`)
export class Expense {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_expenses_company_id')
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
  description!: string;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  @Column({ type: 'text', nullable: true })
  category!: string | null;

  @Column({ type: 'text', nullable: false })
  source_type!: ExpenseSourceType;

  @Column({ type: 'bigint', nullable: false })
  source_id!: string;

  @Column({ type: 'text', nullable: true })
  source_name!: string | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  expense_date!: Date;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  is_archived!: boolean;

  /**
   * `true` cuando el gasto fue materializado por el pago de un gasto FIJO
   * (`PayFixedExpensePeriodsAction`). Estos NO restan de la ganancia del día
   * (el débito a la fuente ya bajó el saldo; contarlo además lo doble-contaría)
   * ni aparecen en el listado de gastos variables. Solo viven en el módulo de
   * Gastos Fijos. Los gastos variables (creados por el usuario) son `false`.
   */
  @Column({ type: 'boolean', nullable: false, default: false })
  is_fixed!: boolean;

  /**
   * Corte (`fixed_expense_periods`) al que pertenece este abono cuando
   * `is_fixed = true`. Permite reconstruir en el cierre diario el monto total
   * del corte, su saldo y su vencimiento (el enlace inverso `period.expense_id`
   * solo apunta al último abono). NULL en gastos variables.
   */
  @Column({ type: 'bigint', nullable: true })
  fixed_expense_period_id!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
