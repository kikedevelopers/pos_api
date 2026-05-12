import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';

import { SaleInvoice } from './sale-invoice.entity';

/**
 * `sale_invoice_lines` — Línea de detalle de una venta.
 *
 * Espejo de `placepos/src/main/database/entities/SaleInvoiceLine.ts` con
 * extensión multi-tenant (`company_id` denormalizado).
 *
 * Multi-tenancy: `company_id` denormalizado coincidente con
 * `sale_invoice.company_id` (impuesto por el service al insertar).
 *
 * Cross-tenant guards: `product_id`, `packaging_id`, `product_price_id`
 * deben pertenecer a la company (validado en `CreateSaleAction`). El
 * `product_price.product_id` debe coincidir con `line.product_id` para
 * impedir aplicar un precio de otro producto.
 *
 * Cálculo (Big.js en el service):
 *
 *   subtotal   = unit_price * quantity
 *   iva_amount = subtotal * iva_percentage / 100
 *   total      = subtotal + iva_amount
 *   profit     = (unit_price - unit_cost) * quantity
 *   margin     = (profit / total) * 100   (0 si total = 0)
 */
@Entity('sale_invoice_lines')
@Check('chk_sale_invoice_lines_quantity_positive', 'quantity > 0')
@Check('chk_sale_invoice_lines_unit_price_non_negative', 'unit_price >= 0')
@Check('chk_sale_invoice_lines_unit_cost_non_negative', 'unit_cost >= 0')
@Check('chk_sale_invoice_lines_subtotal_non_negative', 'subtotal >= 0')
@Check(
  'chk_sale_invoice_lines_iva_percentage_valid',
  'iva_percentage >= 0 AND iva_percentage <= 100',
)
@Check('chk_sale_invoice_lines_iva_amount_non_negative', 'iva_amount >= 0')
@Check('chk_sale_invoice_lines_total_non_negative', 'total >= 0')
@Check('chk_sale_invoice_lines_description_not_empty', 'length(btrim(description)) > 0')
export class SaleInvoiceLine {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

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

  @ManyToOne(() => SaleInvoice, (s) => s.lines, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'sale_invoice_id' })
  sale_invoice!: SaleInvoice;

  @Column({ type: 'bigint', nullable: false })
  product_id!: string;

  @ManyToOne(() => Product, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  @Column({ type: 'bigint', nullable: true })
  packaging_id!: string | null;

  @ManyToOne(() => Packaging, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'packaging_id' })
  packaging!: Packaging | null;

  @Column({ type: 'bigint', nullable: true })
  product_price_id!: string | null;

  @ManyToOne(() => ProductPrice, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'product_price_id' })
  product_price!: ProductPrice | null;

  /**
   * Snapshot del nombre del producto. Espejo PlacePos `name`/`description`.
   */
  @Column({ type: 'text', nullable: false })
  description!: string;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  quantity!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
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
  unit_cost!: number;

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
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  iva_percentage!: number;

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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
