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
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { Purchase } from './purchase.entity';

/**
 * `purchase_lines` — Línea de detalle de una compra.
 *
 * Espejo de `placepos/src/main/database/entities/PurchaseLine.ts`. Mantiene
 * los nombres `packaging_qty`, `unit_qty`, `unit_price`, `packaging_price`,
 * `iva_rate` para paridad byte-por-byte del payload.
 *
 * Multi-tenancy: `company_id` denormalizado coincidente con
 * `purchase.company_id` (impuesto por el service al insertar). Defensa en
 * profundidad: aunque la FK a `purchases` previene huérfanos, denormalizar
 * `company_id` permite filtros directos sin join en analytics.
 *
 * Cross-tenant safety: el service valida que `product_id`, `packaging_id` y
 * `supplier_id` pertenezcan a la company antes del INSERT — sin eso, se
 * podría asociar un producto de otra company a la línea (IDOR).
 *
 * Cálculo de totales (Big.js, en el service):
 *
 *   subtotal   = packaging_qty * packaging_price
 *   iva_amount = subtotal * iva_rate / 100
 *   total      = subtotal + iva_amount
 */
@Entity('purchase_lines')
@Check('chk_purchase_lines_packaging_qty_positive', 'packaging_qty > 0')
@Check('chk_purchase_lines_packaging_price_non_negative', 'packaging_price >= 0')
@Check('chk_purchase_lines_unit_qty_non_negative', 'unit_qty >= 0')
@Check('chk_purchase_lines_unit_price_non_negative', 'unit_price >= 0')
@Check('chk_purchase_lines_iva_rate_non_negative', 'iva_rate >= 0')
@Check('chk_purchase_lines_subtotal_non_negative', 'subtotal >= 0')
@Check('chk_purchase_lines_iva_amount_non_negative', 'iva_amount >= 0')
@Check('chk_purchase_lines_total_non_negative', 'total >= 0')
@Check('chk_purchase_lines_name_not_empty', 'length(btrim(name)) > 0')
export class PurchaseLine {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_purchase_lines_company_id')
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
  purchase_id!: string;

  @ManyToOne(() => Purchase, (p) => p.lines, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'purchase_id' })
  purchase!: Purchase;

  @Column({ type: 'bigint', nullable: false })
  product_id!: string;

  @ManyToOne(() => Product, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  /**
   * Denormalizado: permite consultar `purchase_lines` por proveedor sin join
   * contra `purchases`. Espejo PlacePos.
   */
  @Column({ type: 'bigint', nullable: false })
  supplier_id!: string;

  @ManyToOne(() => Supplier, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'supplier_id' })
  supplier!: Supplier;

  @Column({ type: 'text', nullable: false })
  name!: string;

  @Column({ type: 'bigint', nullable: true })
  packaging_id!: string | null;

  @ManyToOne(() => Packaging, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'packaging_id' })
  packaging!: Packaging | null;

  @Column({ type: 'text', nullable: true })
  packaging_name!: string | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    nullable: true,
    transformer: NumericTransformer,
  })
  packaging_value!: number | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  packaging_qty!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  unit_qty!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  unit_price!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  packaging_price!: number;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  iva_rate!: number;

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
  iva_amount!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  total!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
