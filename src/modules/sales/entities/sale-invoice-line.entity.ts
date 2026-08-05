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
import type { ComboRecipeSnapshot } from '@/modules/products/internal/adjust-inventory.helper';

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

  // NULL = fue precio libre, o el nivel de precio se eliminó del catálogo
  // después de la venta. El precio cobrado vive en esta misma línea, así que
  // borrar un nivel jamás altera lo facturado.
  @Column({ type: 'bigint', nullable: true })
  product_price_id!: string | null;

  @ManyToOne(() => ProductPrice, {
    onDelete: 'SET NULL',
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

  /**
   * Nota por línea de venta (una por producto/línea). Opcional. Espejo del
   * `note` por línea del servidor Express offline de PlacePos. El cliente la
   * captura desde el modal del carrito; no afecta cálculos ni inventario.
   */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

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

  /**
   * Snapshot del factor de conversión del empaque (`packagings.value`)
   * CONGELADO al momento en que las unidades se comprometieron. El motor de
   * inventario (`adjustInventory`) lo usa como override; si es `null` (líneas
   * legacy creadas antes de FIX #2) cae al packaging vigente del producto
   * (comportamiento actual). Garantiza que el `DEDUCT` al cobrar y su `RETURN`
   * posterior (anulación / NC) usen el MISMO factor aunque alguien edite el
   * `value` del empaque entre cobro y devolución (simetría → no corrompe stock).
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    nullable: true,
    transformer: NumericTransformer,
  })
  packaging_value!: number | null;

  /**
   * FIX #3 — Receta del COMBO CONGELADA al comprometer las unidades, en la
   * misma unidad mínima que `combo_components.quantity`. Hermana de
   * `packaging_value`: el motor de inventario la usa como override; si es
   * `null` (línea legacy, o línea que no vende un combo) cae a la receta
   * vigente. Garantiza que el `RETURN` de una anulación / NC devuelva
   * EXACTAMENTE los componentes y cantidades que el `DEDUCT` descontó, aunque
   * la receta se haya editado entre medias.
   */
  @Column({ type: 'jsonb', nullable: true })
  combo_recipe!: ComboRecipeSnapshot | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
