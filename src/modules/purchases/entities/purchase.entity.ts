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
import { Carrier } from '@/modules/carriers/entities/carrier.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { PurchaseCredit } from './purchase-credit.entity';
import { PurchaseLine } from './purchase-line.entity';

/**
 * Estado de una compra. Mirror byte-por-byte del enum `PurchaseStatus` de
 * PlacePos.
 *
 *   - `PENDING`: recién creada; sin recepción confirmada. La mercancía
 *     todavía no llegó a la bodega.
 *   - `RECEIVED`: la mercancía fue recibida (transportadora + receptor
 *     registrados). Cargaría inventario si el modelo tuviera `Product.stock`
 *     (Fase 3 omite esa columna — ver TODO en `mark-purchase-received.action.ts`).
 *
 * `enumName: 'purchase_status'` debe coincidir EXACTAMENTE con el CREATE TYPE
 * de la migración 1747008780000.
 */
export enum PurchaseStatus {
  PENDING = 'PENDING',
  RECEIVED = 'RECEIVED',
}

/**
 * `purchases` — Cabecera de una compra a proveedor.
 *
 * Espejo de `placepos/src/main/database/entities/Purchase.ts` con extensión
 * cloud `company_id` (multi-tenancy).
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB
 * --------------------------------------------------------------------------
 *
 *   - `purchase_number` no-blank (`chk_purchases_purchase_number_not_empty`).
 *   - `total >= 0`, `subtotal >= 0`, `iva_total >= 0`.
 *   - Si `status = 'RECEIVED'`, debe tener `received_at`, `carrier_name` y
 *     `received_by` poblados.
 *   - UNIQUE per-company `(company_id, purchase_number)`.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   Toda query DEBE filtrar por `company_id`. El service asigna
 *   `purchase.company_id := req.user.company_id`; nunca acepta override del
 *   payload. Además, el service valida que `supplier_id` (y por extensión
 *   los `product_id`/`packaging_id` de cada línea) pertenezcan al mismo
 *   tenant.
 *
 * --------------------------------------------------------------------------
 * Soft-delete `is_deleted`
 * --------------------------------------------------------------------------
 *
 *   Espejo PlacePos (NO `is_archived` como banks/wallets/suppliers). El
 *   listado público filtra `is_deleted = false`. Las compras pagadas no
 *   pueden borrarse: el endpoint DELETE solo permite soft-delete si el
 *   PurchaseCredit asociado sigue en `PENDING`.
 */
@Entity('purchases')
@Check('chk_purchases_purchase_number_not_empty', 'length(btrim(purchase_number)) > 0')
@Check('chk_purchases_total_non_negative', 'total >= 0')
@Check('chk_purchases_subtotal_non_negative', 'subtotal >= 0')
@Check('chk_purchases_iva_total_non_negative', 'iva_total >= 0')
@Check(
  'chk_purchases_received_consistency',
  `status = 'PENDING'
   OR (
     received_at IS NOT NULL
     AND length(btrim(coalesce(carrier_name, ''))) > 0
     AND length(btrim(coalesce(received_by, ''))) > 0
   )`,
)
@Check('chk_purchases_transport_cost_non_negative', 'transport_cost >= 0')
@Check('chk_purchases_total_kilos_non_negative', 'total_kilos IS NULL OR total_kilos >= 0')
@Check(
  'chk_purchases_carrier_required_when_transport',
  `transport_cost = 0 OR carrier_id IS NOT NULL`,
)
export class Purchase {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_purchases_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text', nullable: false })
  purchase_number!: string;

  @Column({ type: 'bigint', nullable: false })
  supplier_id!: string;

  @ManyToOne(() => Supplier, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'supplier_id' })
  supplier!: Supplier;

  /**
   * Snapshot del `legal_name` del supplier al momento de creación. Inmutable.
   */
  @Column({ type: 'text', nullable: false })
  supplier_name!: string;

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
  iva_total!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  total!: number;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({
    type: 'enum',
    enum: PurchaseStatus,
    enumName: 'purchase_status',
    default: PurchaseStatus.PENDING,
  })
  status!: PurchaseStatus;

  @Column({ type: 'text', nullable: true })
  carrier_name!: string | null;

  /**
   * Transportista al que se asoció la compra. NULL si la compra no usó
   * carrier registrado. Snapshot del nombre vive en `carrier_name`.
   *
   * Validación multi-tenant: la action exige `carrier.company_id = company_id`
   * antes de asignar — Postgres no admite cross-row CHECK.
   */
  @Column({ type: 'bigint', nullable: true })
  carrier_id!: string | null;

  @ManyToOne(() => Carrier, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'carrier_id' })
  carrier!: Carrier | null;

  /**
   * Costo de flete pagado al transportista. Se persiste como NUMERIC(15,2).
   * Si `> 0` exige `carrier_id` (CHECK) y genera `CarrierCredit` en la
   * misma transacción de creación.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  transport_cost!: number;

  /**
   * Peso total transportado en kg. NULL si no aplica. NUMERIC(15,4) para
   * permitir precisión sub-gramo en caso necesario.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    nullable: true,
    transformer: NumericTransformer,
  })
  total_kilos!: number | null;

  @Column({ type: 'text', nullable: true })
  received_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  received_at!: Date | null;

  /**
   * Fecha de la factura física del proveedor. Espejo PlacePos. NULL si la
   * compra se registra sin factura formal (remisión interna).
   */
  @Column({ type: 'date', nullable: true })
  invoice_date!: Date | null;

  /**
   * Número de la factura del proveedor. PlacePos permite NULL y duplicados
   * intencionales (devoluciones / cambios). Sin UNIQUE.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  invoice_number!: string | null;

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

  @OneToMany(() => PurchaseLine, (l) => l.purchase)
  lines!: PurchaseLine[];

  /**
   * Relación 1:1 con `PurchaseCredit`. Cada compra tiene exactamente un
   * credit (UNIQUE en la migración). La FK vive en `PurchaseCredit`.
   */
  @OneToOne(() => PurchaseCredit, (c) => c.purchase)
  credit!: PurchaseCredit | null;
}
