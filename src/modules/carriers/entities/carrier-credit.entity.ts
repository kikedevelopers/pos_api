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
import { Purchase } from '@/modules/purchases/entities/purchase.entity';

import { Carrier } from './carrier.entity';

/**
 * Estado de un crédito de transportista. Espeja la semántica de
 * `PurchaseCredit` pero con valor `PARTIAL` (no `PARTIALLY_PAID`) para
 * alinearse con el shape de PlacePos `/carriers`.
 */
export enum CarrierCreditStatus {
  PENDING = 'PENDING',
  PARTIAL = 'PARTIAL',
  PAID = 'PAID',
}

/**
 * `carrier_credits` — Cuenta por pagar a un transportista, asociada 1:1 a
 * una compra.
 *
 * --------------------------------------------------------------------------
 * Invariantes contables (CHECK en DB)
 * --------------------------------------------------------------------------
 *
 *   - `total >= 0`, `paid_amount >= 0`, `balance >= 0`.
 *   - `paid_amount <= total`.
 *   - `paid_amount + balance ≈ total` (tolerancia 1¢ por redondeo Big.js).
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   `company_id` denormalizado para indexar sin join. UNIQUE
 *   `(company_id, purchase_id)` garantiza 1:1 con la compra.
 */
@Entity('carrier_credits')
@Check('chk_carrier_credits_total_non_negative', 'total >= 0')
@Check('chk_carrier_credits_paid_non_negative', 'paid_amount >= 0')
@Check('chk_carrier_credits_balance_non_negative', 'balance >= 0')
@Check('chk_carrier_credits_paid_not_exceed_total', 'paid_amount <= total')
@Check('chk_carrier_credits_accounting_invariant', 'abs((paid_amount + balance) - total) < 0.01')
export class CarrierCredit {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_carrier_credits_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Index('idx_carrier_credits_carrier_id')
  @Column({ type: 'bigint', nullable: false })
  carrier_id!: string;

  @ManyToOne(() => Carrier, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'carrier_id' })
  carrier!: Carrier;

  @Column({ type: 'bigint', nullable: false })
  purchase_id!: string;

  @ManyToOne(() => Purchase, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'purchase_id' })
  purchase!: Purchase;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  total!: number;

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
    default: 0,
    transformer: NumericTransformer,
  })
  balance!: number;

  @Column({
    type: 'enum',
    enum: CarrierCreditStatus,
    enumName: 'carrier_credit_status',
    default: CarrierCreditStatus.PENDING,
  })
  status!: CarrierCreditStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
