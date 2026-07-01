import {
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
 * Tipo de evento del historial de estados de una venta. Cada valor representa
 * una TRANSICIÓN de estado real de la `sale_invoices`, no una foto puntual —
 * juntos reconstruyen la LÍNEA DE TIEMPO que el TicketViewer dibuja.
 *
 * `enumName: 'sale_status_event_type'` debe coincidir EXACTAMENTE con el
 * `CREATE TYPE` de la migración `1747011980000`.
 *
 *   - `CREATED`       — se creó el pedido (ORDER) o la venta.
 *   - `COLLECTED`     — el pedido se cobró y se convirtió en venta (ORDER→SALE),
 *                       o se re-cobró un saldo derivado de una venta sin crédito.
 *   - `CREDIT_OPENED` — quedó un saldo a fiar → se abrió un `sale_credits`.
 *   - `INSTALLMENT`   — abono a un crédito existente.
 *   - `PAID`          — el crédito quedó saldado por completo.
 *   - `VOIDED`        — la venta/pedido se anuló.
 *
 * Paridad PlacePos: el cliente offline replica este mismo catálogo de eventos.
 */
export enum SaleStatusEventType {
  CREATED = 'CREATED',
  COLLECTED = 'COLLECTED',
  CREDIT_OPENED = 'CREDIT_OPENED',
  INSTALLMENT = 'INSTALLMENT',
  PAID = 'PAID',
  VOIDED = 'VOIDED',
}

/**
 * `sale_status_history` — Bitácora inmutable de las transiciones de estado de
 * una venta. Cada fila es un evento con su FECHA exacta (`created_at`), de modo
 * que ordenando por `created_at` se obtiene la línea de tiempo del ticket.
 *
 * --------------------------------------------------------------------------
 * Diseño
 * --------------------------------------------------------------------------
 *
 *   - `company_id` NOT NULL — multi-tenant; toda lectura filtra por company.
 *   - `sale_invoice_id` FK CASCADE — si la venta se borra físicamente (solo
 *     ORDER sin rastro), su historial se va con ella.
 *   - `amount` NUMERIC(15,2) NULLABLE — monto asociado al evento cuando aplica
 *     (cobro, abono, total del crédito abierto). NULL en hitos sin monto
 *     (CREATED, PAID, VOIDED).
 *   - `created_by` — snapshot del nombre del actor (NO FK: puede ser un
 *     empleado ya borrado; preservamos la auditoría histórica).
 *   - `created_at` `@CreateDateColumn` timestamptz — la fecha del evento.
 *
 * Índice compuesto `(sale_invoice_id, created_at)` para leer la línea de tiempo
 * de una venta ordenada sin sort en memoria.
 *
 * Las filas NUNCA se actualizan ni se borran por lógica de negocio: append-only.
 */
@Entity('sale_status_history')
@Index('idx_sale_status_history_invoice_created', ['sale_invoice_id', 'created_at'])
export class SaleStatusHistory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_sale_status_history_company_id')
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

  @ManyToOne(() => SaleInvoice, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'sale_invoice_id' })
  sale_invoice!: SaleInvoice;

  @Column({
    type: 'enum',
    enum: SaleStatusEventType,
    enumName: 'sale_status_event_type',
  })
  event_type!: SaleStatusEventType;

  /**
   * Monto asociado al evento. NULL para hitos sin monto (CREATED, PAID, VOIDED).
   * Numeric exacto (NumericTransformer) — nunca float.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: NumericTransformer,
  })
  amount!: number | null;

  /** Snapshot del nombre del actor. NULL si el evento no tiene actor conocido. */
  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
