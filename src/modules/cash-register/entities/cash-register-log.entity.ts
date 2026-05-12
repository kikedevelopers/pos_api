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

import { NumericTransformer } from '@/common/utils/numeric-transformer';

import { CashRegister } from './cash-register.entity';

/**
 * Tipo de movimiento puntual dentro de un turno de caja. Espeja los strings
 * que PlacePos guarda en `cash_register_log.movement_type` como texto libre.
 */
export enum CashRegisterLogType {
  CASH_IN = 'CASH_IN',
  CASH_OUT = 'CASH_OUT',
  CASH_TRANSFER_IN = 'CASH_TRANSFER_IN',
  CASH_TRANSFER_OUT = 'CASH_TRANSFER_OUT',
  COUNT = 'COUNT',
}

/**
 * Dirección de un log de caja. PlacePos lo guarda como text; aquí
 * preservamos el formato pero validado por CHECK constraint.
 */
export type CashRegisterLogDirection = 'IN' | 'OUT';

/**
 * `cash_register_logs` — Eventos dentro de un turno de caja.
 *
 * Cada log referencia su turno por `cash_register_id` (FK RESTRICT) y
 * denormaliza `company_id` para indexar por tenant sin join. Coherencia
 * cross-table (log.company_id === log.cash_register.company_id) es
 * responsabilidad del service; la migración no impone CHECK cross-table.
 *
 * `affects_balance = true` sumará/restará del expected_balance del turno
 * al momento de cierre. `false` es un log informativo (ej: conteo
 * intermedio).
 */
@Entity('cash_register_logs')
@Check('chk_cash_register_logs_direction', `direction IN ('IN', 'OUT')`)
@Check('chk_cash_register_logs_amount_non_negative', 'amount >= 0')
export class CashRegisterLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_cash_register_logs_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @Index('idx_cash_register_logs_cash_register_id')
  @Column({ type: 'bigint', nullable: false })
  cash_register_id!: string;

  @ManyToOne(() => CashRegister, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'cash_register_id' })
  cash_register!: CashRegister;

  @Column({
    type: 'enum',
    enum: CashRegisterLogType,
    enumName: 'cash_register_log_type',
  })
  type!: CashRegisterLogType;

  @Column({ type: 'text' })
  direction!: CashRegisterLogDirection;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  @Column({ type: 'boolean', default: true })
  affects_balance!: boolean;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
