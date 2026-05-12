import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { Purchase } from './purchase.entity';

/**
 * Estado del credit de compra. Mirror del enum `CreditStatus` de PlacePos.
 *
 *   - `PENDING`: ningún pago aplicado todavía. `paid_amount = 0`.
 *   - `PARTIALLY_PAID`: hay al menos un pago, pero queda saldo (`balance > 0`).
 *   - `PAID`: liquidado completamente (`balance = 0`).
 */
export enum PurchaseCreditStatus {
  PENDING = 'PENDING',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
}

/**
 * `purchase_credits` — Deuda del negocio con un supplier por una compra.
 *
 * Espejo de `placepos/src/main/database/entities/PurchaseCredit.ts` con
 * extensión multi-tenant (`company_id`).
 *
 * Cada `Purchase` genera AL CREARSE un row con `total_amount = purchase.total`,
 * `paid_amount = 0`, `balance = purchase.total`, `status = 'PENDING'`. Cada
 * `PurchasePayment` decrementa `balance` y aumenta `paid_amount`. El status
 * transiciona vía CHECK constraint a `PARTIALLY_PAID` / `PAID` según los
 * montos.
 *
 * Invariantes en DB:
 *
 *   - `total_amount > 0`.
 *   - `paid_amount >= 0`, `balance >= 0`.
 *   - `paid_amount <= total_amount`.
 *   - `paid_amount + balance = total_amount` (consistencia contable).
 *   - Status coherente con los montos.
 */
@Entity('purchase_credits')
@Check('chk_purchase_credits_total_positive', 'total_amount > 0')
@Check('chk_purchase_credits_paid_non_negative', 'paid_amount >= 0')
@Check('chk_purchase_credits_balance_non_negative', 'balance >= 0')
@Check('chk_purchase_credits_paid_lte_total', 'paid_amount <= total_amount')
@Check('chk_purchase_credits_balance_consistency', 'paid_amount + balance = total_amount')
@Check(
  'chk_purchase_credits_status_consistency',
  `(status = 'PENDING' AND paid_amount = 0)
   OR (status = 'PARTIALLY_PAID' AND paid_amount > 0 AND balance > 0)
   OR (status = 'PAID' AND balance = 0 AND paid_amount = total_amount)`,
)
export class PurchaseCredit {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_purchase_credits_company_id')
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

  /**
   * Relación 1:1 con `Purchase`. UNIQUE per-company `(company_id, purchase_id)`
   * garantiza la cardinalidad.
   */
  @OneToOne(() => Purchase, (p) => p.credit, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'purchase_id' })
  purchase!: Purchase;

  @Column({ type: 'bigint', nullable: false })
  supplier_id!: string;

  @ManyToOne(() => Supplier, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'supplier_id' })
  supplier!: Supplier;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  total_amount!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  paid_amount!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  balance!: number;

  @Column({
    type: 'enum',
    enum: PurchaseCreditStatus,
    enumName: 'credit_status',
    default: PurchaseCreditStatus.PENDING,
  })
  status!: PurchaseCreditStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
