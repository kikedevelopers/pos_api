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
 * Estado de un turno de caja. UN solo `open` por company (UNIQUE parcial en
 * la migración).
 */
export enum CashRegisterStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

/**
 * `cash_registers` — Turno de caja (apertura / cierre).
 *
 * Cada apertura genera un row con `status = 'open'` y `opening_balance`.
 * Sólo puede existir UN turno `open` por company (índice UNIQUE parcial
 * `idx_cash_registers_one_open_per_company`).
 *
 * El cierre actualiza el row a `status = 'closed'` con `closing_balance`,
 * `expected_balance`, `difference` y `closed_at`. El CHECK
 * `chk_cash_registers_closed_complete` blinda la invariante a nivel físico.
 *
 * El abridor (XOR `opened_by_user_id` / `opened_by_employee_id`) refleja
 * que la sesión puede ser de un User (owner) o un Employee — nunca ambos.
 */
@Entity('cash_registers')
@Check(
  'chk_cash_registers_opener_xor',
  `(opened_by_user_id IS NOT NULL AND opened_by_employee_id IS NULL)
   OR (opened_by_user_id IS NULL AND opened_by_employee_id IS NOT NULL)`,
)
@Check(
  'chk_cash_registers_closed_complete',
  `status = 'open'
   OR (
     closing_balance IS NOT NULL
     AND expected_balance IS NOT NULL
     AND difference IS NOT NULL
     AND closed_at IS NOT NULL
   )`,
)
@Check('chk_cash_registers_opening_balance_non_negative', 'opening_balance >= 0')
export class CashRegister {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_cash_registers_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint', nullable: true })
  opened_by_user_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  opened_by_employee_id!: string | null;

  @Column({ type: 'text', nullable: true })
  opened_by_name!: string | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  opening_balance!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: NumericTransformer,
  })
  closing_balance!: number | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: NumericTransformer,
  })
  expected_balance!: number | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: NumericTransformer,
  })
  difference!: number | null;

  @Column({
    type: 'enum',
    enum: CashRegisterStatus,
    enumName: 'cash_register_status',
    default: CashRegisterStatus.OPEN,
  })
  status!: CashRegisterStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  opened_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closed_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
