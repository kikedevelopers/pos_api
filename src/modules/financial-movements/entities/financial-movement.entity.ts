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

/**
 * Tipo de movimiento. Coincide con `MovementType` de PlacePos.
 *
 *   - `INCOME`: dinero entra a una cuenta (equivale a "credit" del prompt).
 *   - `EXPENSE`: dinero sale de una cuenta (equivale a "debit").
 *   - `TRANSFER`: par de movimientos cuando hay traslado entre cuentas
 *     propias del negocio. La action de transferencia inserta DOS rows:
 *     uno EXPENSE en source y otro INCOME en destination.
 */
export enum MovementType {
  INCOME = 'INCOME',
  EXPENSE = 'EXPENSE',
  TRANSFER = 'TRANSFER',
}

/**
 * Concepto que originó el movimiento. Espeja los valores de PlacePos +
 * agrega `ADJUSTMENT`, `CREDIT_PAYMENT`, `CREDIT_NOTE_REFUND` para
 * cubrir flujos del cloud (los frontends futuros pueden ignorarlos sin
 * romper paridad).
 *
 * `REFUND` y `SALE_PAYMENT` se añaden vía migración
 * `1747010460000-extend-movement-concept-enum` para mantener paridad
 * con PlacePos. Los callers actuales que usan `ADJUSTMENT`/`CREDIT_PAYMENT`
 * NO se migran automáticamente — la semántica de cada caso (sobrante de
 * caja vs devolución vs abono a cartera) se decide caller por caller.
 */
export enum MovementConcept {
  SALE = 'SALE',
  PURCHASE = 'PURCHASE',
  EXPENSE = 'EXPENSE',
  EXPENSE_PAYMENT = 'EXPENSE_PAYMENT',
  TRANSFER = 'TRANSFER',
  INITIAL_BALANCE = 'INITIAL_BALANCE',
  ADJUSTMENT = 'ADJUSTMENT',
  CREDIT_PAYMENT = 'CREDIT_PAYMENT',
  CREDIT_NOTE_REFUND = 'CREDIT_NOTE_REFUND',
  REFUND = 'REFUND',
  SALE_PAYMENT = 'SALE_PAYMENT',
  CARRIER_PAYMENT = 'CARRIER_PAYMENT',
  CUSTOMER_ADVANCE = 'CUSTOMER_ADVANCE',
}

/**
 * Referencia de cuenta usada en source/destination. Espeja el shape texto-
 * libre de PlacePos. Validado por CHECK constraint en la migración.
 */
export type AccountReference = 'bank' | 'wallet' | 'cash_register' | 'external';

/**
 * `financial_movements` — Tabla de AUDITORÍA inmutable.
 *
 * Cada cambio de balance (venta, compra, traslado, saldo inicial, etc.)
 * inserta un row. Los reportes financieros se construyen sobre esta tabla,
 * NO sobre los balances corrientes de banks/wallets — así detectamos
 * desincronizaciones.
 *
 * Endpoint público: GET con filtros. POSTs vienen exclusivamente desde
 * otras actions internas (sales, accounts.transfer, etc.) DENTRO de la
 * misma transacción que el cambio de balance.
 */
@Entity('financial_movements')
@Check('chk_financial_movements_amount_positive', 'amount > 0')
@Check(
  'chk_financial_movements_account_types',
  `(source_type IS NULL OR source_type IN ('bank', 'wallet', 'cash_register', 'external'))
   AND (destination_type IS NULL OR destination_type IN ('bank', 'wallet', 'cash_register', 'external'))`,
)
@Check(
  'chk_financial_movements_source_consistency',
  `(source_type IS NULL AND source_id IS NULL)
   OR (source_type IS NOT NULL AND source_id IS NOT NULL)`,
)
@Check(
  'chk_financial_movements_destination_consistency',
  `(destination_type IS NULL AND destination_id IS NULL)
   OR (destination_type IS NOT NULL AND destination_id IS NOT NULL)`,
)
@Check(
  'chk_financial_movements_has_endpoint',
  'source_type IS NOT NULL OR destination_type IS NOT NULL',
)
export class FinancialMovement {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_financial_movements_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  @Column({ type: 'enum', enum: MovementType, enumName: 'movement_type' })
  movement_type!: MovementType;

  @Column({ type: 'enum', enum: MovementConcept, enumName: 'movement_concept' })
  concept!: MovementConcept;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  source_type!: AccountReference | null;

  @Column({ type: 'bigint', nullable: true })
  source_id!: string | null;

  @Column({ type: 'text', nullable: true })
  destination_type!: AccountReference | null;

  @Column({ type: 'bigint', nullable: true })
  destination_id!: string | null;

  @Column({ type: 'text', nullable: true })
  reference_code!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
