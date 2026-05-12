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
import { Customer } from '@/modules/customers/entities/customer.entity';

import { SaleInvoice } from './sale-invoice.entity';

/**
 * Estado del credit de venta. Reutiliza el enum Postgres `credit_status`
 * (`PENDING` | `PARTIALLY_PAID` | `PAID`) creado en migración
 * `1747008960000-create-purchase-credits-table`. Espejo PlacePos.
 */
export enum SaleCreditStatus {
  PENDING = 'PENDING',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
}

/**
 * `sale_credits` — Deuda del cliente con la empresa por una venta a crédito.
 *
 * Espejo de `placepos/src/main/database/entities/SaleCredit.ts` con extensión
 * multi-tenant (`company_id`).
 *
 * --------------------------------------------------------------------------
 * Cuándo se crea
 * --------------------------------------------------------------------------
 *
 *   Sólo cuando la venta queda con saldo pendiente (`Σ payments < total`)
 *   AL CREARSE, Y la venta tiene `customer_id` (no se puede dejar deuda en
 *   ventas mostrador). Espejo PlacePos.
 *
 *   `total_amount = sale.total`, `paid_amount = Σ payments aplicados`,
 *   `balance = total - paid_amount`.
 *
 *   `status`:
 *     - `PENDING` si `paid_amount = 0`.
 *     - `PARTIALLY_PAID` si `paid_amount > 0 AND balance > 0`.
 *
 *   El status `PAID` se alcanza cuando se aplican pagos suficientes vía
 *   `POST /sales/:id/payments` o `POST /payments` (Fase 9).
 *
 * --------------------------------------------------------------------------
 * Invariantes en DB
 * --------------------------------------------------------------------------
 *
 *   - `total_amount > 0`.
 *   - `paid_amount >= 0`, `balance >= 0`.
 *   - `paid_amount <= total_amount`.
 *   - `paid_amount + balance = total_amount`.
 *   - Status coherente con los montos.
 */
@Entity('sale_credits')
@Check('chk_sale_credits_total_positive', 'total_amount > 0')
@Check('chk_sale_credits_paid_non_negative', 'paid_amount >= 0')
@Check('chk_sale_credits_balance_non_negative', 'balance >= 0')
@Check('chk_sale_credits_paid_lte_total', 'paid_amount <= total_amount')
@Check('chk_sale_credits_balance_consistency', 'paid_amount + balance = total_amount')
@Check(
  'chk_sale_credits_status_consistency',
  `(status = 'PENDING' AND paid_amount = 0)
   OR (status = 'PARTIALLY_PAID' AND paid_amount > 0 AND balance > 0)
   OR (status = 'PAID' AND balance = 0 AND paid_amount = total_amount)`,
)
export class SaleCredit {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_sale_credits_company_id')
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

  /**
   * Relación 1:1 con `SaleInvoice`. UNIQUE per-company
   * `(company_id, sale_invoice_id)` garantiza la cardinalidad.
   */
  @OneToOne(() => SaleInvoice, (s) => s.credit, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'sale_invoice_id' })
  sale_invoice!: SaleInvoice;

  @Column({ type: 'bigint', nullable: false })
  customer_id!: string;

  @ManyToOne(() => Customer, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

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

  @Column({ type: 'date', nullable: true })
  due_date!: Date | null;

  @Column({
    type: 'enum',
    enum: SaleCreditStatus,
    enumName: 'credit_status',
    default: SaleCreditStatus.PENDING,
  })
  status!: SaleCreditStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
