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
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CarrierCredit } from '@/modules/carriers/entities/carrier-credit.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { FinancialMovement } from '@/modules/financial-movements/entities/financial-movement.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

/**
 * Método de pago al transportista. Espeja PlacePos.
 */
export enum CarrierPaymentMethod {
  CASH = 'CASH',
  BANK = 'BANK',
  WALLET = 'WALLET',
}

/**
 * `carrier_payments` — Abono concreto a un `CarrierCredit`.
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB
 * --------------------------------------------------------------------------
 *
 *   - `amount > 0`.
 *   - CASH → `bank_id IS NULL AND wallet_id IS NULL`.
 *   - BANK → `bank_id IS NOT NULL AND wallet_id IS NULL`.
 *   - WALLET → `wallet_id IS NOT NULL AND bank_id IS NULL`.
 *
 * --------------------------------------------------------------------------
 * `financial_movement_id` NOT NULL
 * --------------------------------------------------------------------------
 *
 *   Cada pago genera un FM auditable. Para CASH, se inserta un FM
 *   "marcador" con `source_type='cash_register'` y `source_id=null`
 *   (la caja YA descontó el dinero a través de un `cash_register_log`
 *   `affects_balance=false`, por lo que evitar doble contabilización).
 */
@Entity('carrier_payments')
@Check('chk_carrier_payments_amount_positive', 'amount > 0')
@Check(
  'chk_carrier_payments_method_source',
  `(payment_method = 'CASH' AND bank_id IS NULL AND wallet_id IS NULL)
   OR (payment_method = 'BANK' AND bank_id IS NOT NULL AND wallet_id IS NULL)
   OR (payment_method = 'WALLET' AND wallet_id IS NOT NULL AND bank_id IS NULL)`,
)
export class CarrierPayment {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_carrier_payments_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Index('idx_carrier_payments_credit_id')
  @Column({ type: 'bigint', nullable: false })
  carrier_credit_id!: string;

  @ManyToOne(() => CarrierCredit, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'carrier_credit_id' })
  carrier_credit!: CarrierCredit;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  @Column({
    type: 'enum',
    enum: CarrierPaymentMethod,
    enumName: 'carrier_payment_method',
  })
  payment_method!: CarrierPaymentMethod;

  @Column({ type: 'bigint', nullable: true })
  bank_id!: string | null;

  @ManyToOne(() => Bank, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'bank_id' })
  bank!: Bank | null;

  @Column({ type: 'bigint', nullable: true })
  wallet_id!: string | null;

  @ManyToOne(() => Wallet, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'wallet_id' })
  wallet!: Wallet | null;

  @Column({ type: 'bigint', nullable: false })
  financial_movement_id!: string;

  @ManyToOne(() => FinancialMovement, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'financial_movement_id' })
  financial_movement!: FinancialMovement;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
