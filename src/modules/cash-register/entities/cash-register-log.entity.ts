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
 * Tipo de operación que generó el log. Espejo byte-por-byte de los valores
 * que PlacePos guarda en `cash_register_log.movement_type`.
 */
export enum CashRegisterLogType {
  CASH_RECEIVED = 'CASH_RECEIVED',
  CASH_PAYMENT = 'CASH_PAYMENT',
  CASH_CHANGE = 'CASH_CHANGE',
  CREDIT_PAYMENT = 'CREDIT_PAYMENT',
  CREDIT_NOTE_FULL_VOID = 'CREDIT_NOTE_FULL_VOID',
  CREDIT_NOTE_PARTIAL_VOID = 'CREDIT_NOTE_PARTIAL_VOID',
  DEBIT_NOTE = 'DEBIT_NOTE',
  CARRIER_PAYMENT = 'CARRIER_PAYMENT',
  EXPENSE = 'EXPENSE',
  VOID_EXPENSE = 'VOID_EXPENSE',
  DELIVERY_PAYMENT = 'DELIVERY_PAYMENT',
  VOID_DELIVERY_PAYMENT = 'VOID_DELIVERY_PAYMENT',
  REFUND = 'REFUND',
  PURCHASE_PAYMENT = 'PURCHASE_PAYMENT',
  CASH_TRANSFER_OUT = 'CASH_TRANSFER_OUT',
  CASH_TRANSFER_IN = 'CASH_TRANSFER_IN',
  ADMIN_ADJUSTMENT = 'ADMIN_ADJUSTMENT',
  CASH_OVERAGE = 'CASH_OVERAGE',
  CASH_SHORTAGE = 'CASH_SHORTAGE',
  CUSTOMER_ADVANCE = 'CUSTOMER_ADVANCE',
}

/**
 * Dirección de un log de caja. PlacePos lo guarda como text; aquí preservamos
 * el formato pero validado por CHECK constraint.
 */
export type CashRegisterLogDirection = 'IN' | 'OUT';

/**
 * `cash_register_logs` — Eventos de AUDITORÍA sobre la caja.
 *
 * --------------------------------------------------------------------------
 * Modelo (paridad PlacePos)
 * --------------------------------------------------------------------------
 *
 * Cada log documenta UNA mutación del balance de la caja (cobro, gasto,
 * transferencia, etc.) o un evento informativo (`affects_balance=false`).
 *
 * IMPORTANTE: con el modelo PERMANENTE, el balance NO se deriva de los logs.
 * El balance vive en `cash_registers.balance` y se mutea con UPDATE atómico
 * dentro de la transacción que también inserta el log. Por tanto
 * `affects_balance` es metadata documental — NO se "aplica" sumando/restando
 * desde el log.
 *
 * --------------------------------------------------------------------------
 * Relaciones opcionales (Fase 4+)
 * --------------------------------------------------------------------------
 *
 * `invoice_id`, `payment_id`, `credit_note_id` enlazan el log con el recurso
 * que lo originó. Todos nullable porque muchos logs son globales (ajustes,
 * transferencias).
 *
 * `is_credit_related` es bandera derivada que el frontend usa para filtrar
 * logs de flujos de crédito sin tener que correlacionar `type` (espejo
 * PlacePos).
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

  /**
   * Bandera DOCUMENTAL: indica si el log corresponde a una mutación del
   * balance (true) o a un evento informativo (false). NO se usa para
   * recomputar el balance — el balance vive en `cash_registers.balance`.
   */
  @Column({ type: 'boolean', default: true })
  affects_balance!: boolean;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  /**
   * Enlace opcional con la venta que generó el log. FK ON DELETE SET NULL en
   * la migración: si la venta se borra, el log persiste sin la referencia.
   */
  @Column({ type: 'bigint', nullable: true })
  invoice_id!: string | null;

  /**
   * Enlace opcional con el pago que generó el log.
   */
  @Column({ type: 'bigint', nullable: true })
  payment_id!: string | null;

  /**
   * Enlace opcional con la nota crédito/débito que generó el log.
   */
  @Column({ type: 'bigint', nullable: true })
  credit_note_id!: string | null;

  /**
   * Bandera derivada: true cuando el flujo origen es un pago/anulación con
   * impacto en `SaleCredit` (PlacePos lo persiste así para filtros rápidos).
   */
  @Column({ type: 'boolean', default: false })
  is_credit_related!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
