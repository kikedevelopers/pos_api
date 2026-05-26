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

import { DeliveryCompany } from './delivery-company.entity';

/**
 * Método de pago de un domicilio. Espejo del feature PlacePos: validado por
 * CHECK constraint en la migración.
 *
 *   - `on_delivery`  — el domiciliario cobra al cliente; NO toca caja.
 *   - `cash_register` — la company paga al domiciliario desde la caja del
 *     cajero (egreso de caja + CashRegisterLog).
 */
export type DeliveryPaymentMethod = 'on_delivery' | 'cash_register';

/**
 * `deliveries` — Domicilio (entrega) registrado por una company.
 *
 * Espejo del feature "Domiciliarios" de PlacePos con extensión multi-tenant
 * (`company_id` NOT NULL).
 *
 * --------------------------------------------------------------------------
 * Modelado
 * --------------------------------------------------------------------------
 *
 *   - `invoice_id` nullable FK a `sale_invoices` ON DELETE SET NULL — un
 *     domicilio puede estar (o no) ligado a una venta. `ticket_number` es un
 *     snapshot del ticket de esa venta al momento de registrar el domicilio.
 *   - `delivery_company_id` FK a `delivery_companies` ON DELETE RESTRICT — no
 *     se permite borrar un domiciliario con entregas. `delivery_company_name`
 *     es snapshot del nombre.
 *   - `amount numeric(15,2)` — valor del domicilio (lo que se paga al
 *     domiciliario, o lo que cobra contra-entrega). Money rule.
 *   - `payment_method` text validado por CHECK.
 *   - `cash_register_log_id` nullable — enlaza con el CashRegisterLog del
 *     egreso cuando `payment_method = 'cash_register'`.
 *   - `is_archived` boolean — soft-delete; al archivar un domicilio pagado de
 *     caja, se revierte el egreso (ingreso a caja).
 *
 * --------------------------------------------------------------------------
 * Invariantes
 * --------------------------------------------------------------------------
 *
 *   - `amount >= 0` (CHECK).
 *   - `payment_method IN ('on_delivery', 'cash_register')` (CHECK).
 *   - `destination_address` y `recipient_name` no-blank (CHECK).
 */
@Entity('deliveries')
@Check('chk_deliveries_amount_non_negative', 'amount >= 0')
@Check('chk_deliveries_payment_method_values', `payment_method IN ('on_delivery', 'cash_register')`)
@Check('chk_deliveries_destination_address_not_empty', 'length(btrim(destination_address)) > 0')
@Check('chk_deliveries_recipient_name_not_empty', 'length(btrim(recipient_name)) > 0')
export class Delivery {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_deliveries_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint', nullable: true })
  invoice_id!: string | null;

  /** Snapshot del ticket de la venta ligada (si existe). */
  @Column({ type: 'text', nullable: true })
  ticket_number!: string | null;

  @Column({ type: 'bigint', nullable: false })
  delivery_company_id!: string;

  @ManyToOne(() => DeliveryCompany, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'delivery_company_id' })
  delivery_company!: DeliveryCompany;

  /** Snapshot del nombre del domiciliario al momento del registro. */
  @Column({ type: 'text', nullable: false })
  delivery_company_name!: string;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    transformer: NumericTransformer,
  })
  amount!: number;

  @Column({ type: 'text', nullable: false })
  payment_method!: DeliveryPaymentMethod;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'text', nullable: false })
  destination_address!: string;

  @Column({ type: 'text', nullable: false })
  recipient_name!: string;

  /** Enlace al CashRegisterLog del egreso (solo si payment_method=cash_register). */
  @Column({ type: 'bigint', nullable: true })
  cash_register_log_id!: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  is_archived!: boolean;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
