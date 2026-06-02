import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';

import { SaleCredit } from './sale-credit.entity';
import { SaleInvoiceLine } from './sale-invoice-line.entity';
import { SalePayment } from './sale-payment.entity';

/**
 * Tipo de ticket. Mirror byte-por-byte de `TicketType` en PlacePos.
 *
 *   - `ORDER`: pedido editable, anulable directo (soft-delete) sin nota.
 *   - `SALE`: venta confirmada, solo anulable vía CreditNote (Fase 8).
 *
 * `enumName: 'ticket_type'` debe coincidir EXACTAMENTE con el `CREATE TYPE`
 * de la migración 1747009260000.
 *
 * NOTA: este enum es distinto al `ticket_setting_type` (que incluye además
 * CREDIT_NOTE, DEBIT_NOTE, PURCHASE). El servicio mapea ORDER → ORDER y
 * SALE → SALE al pedir folio al `IncrementTicketNumberAction`.
 */
export enum TicketType {
  ORDER = 'ORDER',
  SALE = 'SALE',
}

/**
 * `sale_invoices` — Cabecera de una venta.
 *
 * Espejo de `placepos/src/main/database/entities/SaleInvoice.ts` con
 * extensión cloud `company_id` (multi-tenancy).
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB
 * --------------------------------------------------------------------------
 *
 *   - `ticket_number` no-blank (`chk_sale_invoices_ticket_number_not_empty`).
 *   - `subtotal`, `tax_total`, `total`, `cost` >= 0.
 *   - Si `ticket_type = 'SALE'`, `sale_number` no puede ser NULL/vacío.
 *   - UNIQUE per-company `(company_id, ticket_number)`.
 *   - UNIQUE per-company parcial `(company_id, sale_number) WHERE
 *     sale_number IS NOT NULL`.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   Toda query DEBE filtrar por `company_id`. El service asigna
 *   `sale.company_id := req.user.company_id`; nunca acepta override del
 *   payload. Cross-tenant guards adicionales para `customer_id`,
 *   `product_id`, `packaging_id`, `product_price_id`, `account_id`.
 *
 * --------------------------------------------------------------------------
 * Soft-delete `is_deleted`
 * --------------------------------------------------------------------------
 *
 *   Convención PlacePos (NO `is_archived`). Las consultas activas filtran
 *   `is_deleted = false`. Las ventas SALE nunca se borran físicamente —
 *   se anulan vía CreditNote(FULL_VOID) que marca `is_deleted = true`
 *   (Fase 8). Las ORDER pueden borrarse directamente sin pagos.
 */
@Entity('sale_invoices')
@Check('chk_sale_invoices_ticket_number_not_empty', 'length(btrim(ticket_number)) > 0')
@Check('chk_sale_invoices_subtotal_non_negative', 'subtotal >= 0')
@Check('chk_sale_invoices_tax_total_non_negative', 'tax_total >= 0')
@Check('chk_sale_invoices_total_non_negative', 'total >= 0')
@Check('chk_sale_invoices_cost_non_negative', 'cost >= 0')
@Check(
  'chk_sale_invoices_sale_number_consistency',
  `ticket_type = 'ORDER'
   OR (ticket_type = 'SALE' AND length(btrim(coalesce(sale_number, ''))) > 0)`,
)
// Idempotencia de la CREACIÓN de la venta: una misma `client_operation_id`
// (uuid del cliente) no puede generar dos facturas en la misma company. Índice
// único PARCIAL (solo aplica cuando la llave no es null) — hace físicamente
// imposible registrar la misma venta dos veces, incluso bajo doble-click /
// reintento de red. Espejo del guard de idempotencia que faltaba en createOrder.
@Index('uq_sale_invoices_client_operation', ['company_id', 'client_operation_id'], {
  unique: true,
  where: '"client_operation_id" IS NOT NULL',
})
export class SaleInvoice {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_sale_invoices_company_id')
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
    type: 'enum',
    enum: TicketType,
    enumName: 'ticket_type',
    default: TicketType.ORDER,
  })
  ticket_type!: TicketType;

  @Column({ type: 'text', nullable: false })
  ticket_number!: string;

  @Column({ type: 'text', nullable: true })
  sale_number!: string | null;

  @Column({ type: 'bigint', nullable: true })
  customer_id!: string | null;

  @ManyToOne(() => Customer, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer | null;

  /**
   * Snapshot del nombre del cliente al momento de la venta. Inmutable
   * (preserva la auditoría histórica si el customer cambia de nombre).
   */
  @Column({ type: 'text', nullable: true })
  customer_name!: string | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  subtotal!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  tax_total!: number;

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
  cost!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  profit!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  margin!: number;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /**
   * UUID v4 generado por el cliente para deduplicar la creación de la venta.
   * Único por company (índice parcial). Si llega una llave ya usada, el action
   * devuelve la venta existente en vez de crear otra. null en ventas legadas o
   * creadas sin idempotencia.
   */
  @Column({ type: 'text', nullable: true })
  client_operation_id!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @Column({ type: 'boolean', default: false })
  is_deleted!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @OneToMany(() => SaleInvoiceLine, (l) => l.sale_invoice)
  lines!: SaleInvoiceLine[];

  @OneToMany(() => SalePayment, (p) => p.sale_invoice)
  payments!: SalePayment[];

  /**
   * Relación 1:1 con `SaleCredit`. UNIQUE per-company
   * `(company_id, sale_invoice_id)` garantiza cardinalidad. NULL si la
   * venta se pagó al contado.
   */
  @OneToOne(() => SaleCredit, (c) => c.sale_invoice)
  credit!: SaleCredit | null;
}
