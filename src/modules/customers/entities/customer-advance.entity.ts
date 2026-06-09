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

import { Customer } from './customer.entity';

/**
 * A qué cuenta entró el dinero del anticipo. Espeja el shape texto-libre de
 * PlacePos:
 *
 *   - `cash_register`: caja del cajero autenticado (resuelta on-the-fly).
 *   - `bank`: cuenta bancaria de la company.
 *   - `wallet`: billetera (cuenta digital) de la company.
 */
export type AdvanceDestinationType = 'cash_register' | 'bank' | 'wallet';

/**
 * `customer_advances` — Anticipos de cliente (dinero recibido por adelantado).
 *
 * --------------------------------------------------------------------------
 * Modelo (contrato `CONTRACT_customer_advance_archive.md`)
 * --------------------------------------------------------------------------
 *
 * Cada fila documenta UN ingreso de dinero como anticipo del cliente. La
 * creación es atómica: en la misma transacción se registra el ingreso de
 * dinero en la cuenta destino (CashRegisterLog para `cash_register`,
 * FinancialMovement para `bank`/`wallet`), se inserta esta fila y se
 * incrementa `customers.advance_balance`.
 *
 * En esta entrega NO hay consumo en ventas ni anulación/reversa.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * `company_id bigint NOT NULL` + FK a companies + índice. Toda query DEBE
 * filtrar por company_id; el service lo asigna desde `req.user.company_id`.
 */
@Entity('customer_advances')
@Check('chk_customer_advances_amount_positive', 'amount > 0')
@Check(
  'chk_customer_advances_destination_type',
  `destination_type IN ('cash_register', 'bank', 'wallet')`,
)
@Check('chk_customer_advances_description_not_empty', 'length(btrim(description)) > 0')
export class CustomerAdvance {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_customer_advances_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Index('idx_customer_advances_customer_id')
  @Column({ type: 'bigint', nullable: false })
  customer_id!: string;

  @ManyToOne(() => Customer, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  /**
   * Concepto/descripción del anticipo. Se propaga también a la descripción del
   * movimiento de caja/financiero generado. NOT NULL no vacío.
   */
  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text' })
  destination_type!: AdvanceDestinationType;

  /**
   * Id real de la cuenta destino donde entró el dinero. Para `cash_register`
   * se guarda el id de la caja del usuario autenticado (resuelta on-the-fly);
   * para `bank`/`wallet`, el id del banco/billetera.
   */
  @Column({ type: 'bigint', nullable: false })
  destination_id!: string;

  /**
   * Código de referencia (uuid) para trazar contra el movimiento generado
   * (CashRegisterLog o FinancialMovement).
   */
  @Column({ type: 'text', nullable: true })
  reference_code!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
