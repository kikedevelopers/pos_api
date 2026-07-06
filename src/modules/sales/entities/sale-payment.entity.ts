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

import { SaleInvoice } from './sale-invoice.entity';

/**
 * Método de pago. Reutiliza el enum Postgres `payment_method` definido en
 * la migración `1747008900000-create-purchase-payments-table` (CASH | TRANSFER).
 * El valor `ADVANCE` se añade en la migración
 * `1747012140000-add-advance-payment-method-enum-value` (redención del saldo a
 * favor del cliente `advance_balance` como medio de pago). Espejo PlacePos.
 */
export enum SalePaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
  /**
   * Redención de anticipo del cliente. NO mueve caja/banco (el dinero ya
   * ingresó al crear el anticipo); solo descuenta `customers.advance_balance`.
   */
  ADVANCE = 'ADVANCE',
}

/**
 * Tipo de cuenta receptora. Espejo del campo libre de PlacePos validado por
 * CHECK constraint en la migración.
 *
 *   - `customer_advance`: pago con anticipo. `account_id` = `customers.id`. NO
 *     hay cuenta de dinero real detrás (el efectivo/banco ya se movió al crear
 *     el anticipo); el pago solo descuenta `advance_balance` del cliente.
 */
export type SalePaymentAccountType = 'wallet' | 'bank' | 'cash_register' | 'customer_advance';

/**
 * `sale_payments` — Cobro a una venta.
 *
 * Espejo de `placepos/src/main/database/entities/SalePayment.ts` con
 * extensiones multi-tenant:
 *
 *   - `company_id` NOT NULL — denormalizado para indexar/filtrar sin join.
 *   - `uuid` UNIQUE composite con `company_id` (idempotency key del cliente).
 *
 * Side effects al insertar (orquestados por la action en una transacción):
 *
 *   1. Acredita el balance de la cuenta receptora:
 *      - bank / wallet: UPDATE balance += amount con SELECT FOR UPDATE.
 *      - cash_register: INSERT CashRegisterLog(direction=IN, type=CASH_IN).
 *   2. Inserta FinancialMovement(INCOME, concept=SALE) con
 *      source_type='external' (cliente) y destination_type=cuenta receptora.
 *   3. Si la venta tiene SaleCredit, decrementa balance/aumenta paid_amount
 *      y actualiza Customer.balance (paridad PlacePos: balance signed).
 *
 * Si llega un `uuid` ya procesado, el service devuelve el row existente con
 * 200 — NO 409 (paridad PlacePos).
 */
@Entity('sale_payments')
@Check('chk_sale_payments_amount_positive', 'amount > 0')
@Check('chk_sale_payments_change_non_negative', 'change_amount >= 0')
@Check(
  'chk_sale_payments_account_type_values',
  `account_type IN ('wallet', 'bank', 'cash_register', 'customer_advance')`,
)
export class SalePayment {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_sale_payments_company_id')
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
  sale_invoice_id!: string;

  @ManyToOne(() => SaleInvoice, (s) => s.payments, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'sale_invoice_id' })
  sale_invoice!: SaleInvoice;

  @Column({
    type: 'enum',
    enum: SalePaymentMethod,
    enumName: 'payment_method',
  })
  payment_method!: SalePaymentMethod;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  change_amount!: number;

  @Column({ type: 'bigint', nullable: true })
  bank_id!: string | null;

  @Column({ type: 'text', nullable: true })
  bank_name!: string | null;

  @Column({ type: 'text', nullable: false })
  account_type!: SalePaymentAccountType;

  @Column({ type: 'bigint', nullable: false })
  account_id!: string;

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

  /**
   * Reverso (soft-delete) del pago. Espejo placepos de la feature
   * "eliminar/reversar un pago de venta". Cuando `is_voided = true` el pago
   * NO cuenta para el saldo de la venta ni para las agregaciones de reportes;
   * el dinero ya fue devuelto a la cuenta original (CashRegisterLog OUT o
   * FinancialMovement EXPENSE concept=PAYMENT_REVERSAL).
   */
  @Column({ type: 'boolean', default: false })
  is_voided!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  voided_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  voided_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  voided_by_id!: string | null;

  @Column({ type: 'text', nullable: true })
  void_reason!: string | null;

  /**
   * Idempotency key del reverso. UNIQUE per-company (índice parcial). Un
   * reintento con el mismo `void_uuid` devuelve el reverso previo en vez de
   * descontar la cuenta dos veces.
   */
  @Column({ type: 'text', nullable: true })
  void_uuid!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
