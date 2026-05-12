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
import { Company } from '@/modules/companies/entities/company.entity';

import { Purchase } from './purchase.entity';

/**
 * Método de pago. Mirror byte-por-byte de `PaymentMethod` de PlacePos.
 *
 *   - `CASH`: efectivo (debe acompañarse de `source_type = 'cash_register'`
 *     o `source_type = 'wallet'`).
 *   - `TRANSFER`: transferencia bancaria (debe acompañarse de
 *     `source_type = 'bank'`).
 */
export enum PurchasePaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
}

/**
 * Tipo de fuente del pago. Espejo del campo libre de PlacePos pero validado
 * por CHECK en la migración.
 */
export type PurchasePaymentSourceType = 'wallet' | 'bank' | 'cash_register';

/**
 * `purchase_payments` — Abono a una compra (`Purchase`).
 *
 * Espejo de `placepos/src/main/database/entities/PurchasePayment.ts` con
 * extensión multi-tenant:
 *
 *   - `company_id` NOT NULL — denormalizado para indexar/filtrar sin join.
 *   - `uuid` UNIQUE composite con `company_id` (idempotency key del cliente).
 *
 * Side effects al insertar (orquestados por la action en una transacción):
 *
 *   1. Debita el balance de la cuenta (wallet/bank/cash_register).
 *   2. Inserta FinancialMovement (EXPENSE, concept = PURCHASE).
 *   3. Decrementa `purchase_credits.balance` y aumenta `paid_amount`.
 *      Actualiza `status` (PARTIALLY_PAID | PAID).
 *   4. Decrementa `suppliers.accumulated_debt`.
 *
 * Si llega un `uuid` ya procesado, el service devuelve el row existente con
 * 200 — NO 409. Comportamiento de idempotencia: un retry por timeout/red NO
 * duplica el cobro.
 */
@Entity('purchase_payments')
@Check('chk_purchase_payments_amount_positive', 'amount > 0')
@Check(
  'chk_purchase_payments_source_type_values',
  `source_type IS NULL OR source_type IN ('wallet', 'bank', 'cash_register')`,
)
@Check(
  'chk_purchase_payments_source_consistency',
  `(source_type IS NULL AND source_id IS NULL)
   OR (source_type IS NOT NULL AND source_id IS NOT NULL)`,
)
export class PurchasePayment {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_purchase_payments_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint', nullable: false })
  purchase_id!: string;

  @ManyToOne(() => Purchase, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'purchase_id' })
  purchase!: Purchase;

  @Column({ type: 'text', nullable: false })
  payment_number!: string;

  @Column({
    type: 'enum',
    enum: PurchasePaymentMethod,
    enumName: 'payment_method',
  })
  payment_method!: PurchasePaymentMethod;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  @Column({ type: 'bigint', nullable: true })
  bank_id!: string | null;

  @Column({ type: 'text', nullable: true })
  bank_name!: string | null;

  @Column({ type: 'text', nullable: true })
  source_type!: PurchasePaymentSourceType | null;

  @Column({ type: 'bigint', nullable: true })
  source_id!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  /**
   * Idempotency key v4 del cliente. UNIQUE per-company (índice parcial).
   * Si llega un uuid ya procesado, el service devuelve el row existente con
   * 200 — NO duplica el cobro.
   */
  @Column({ type: 'text', nullable: true })
  uuid!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
