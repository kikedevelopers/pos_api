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
import type { ComboRecipeSnapshot } from '@/modules/products/internal/adjust-inventory.helper';
import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';

import { CreditNote } from './credit-note.entity';

/**
 * `credit_note_lines` — Línea de detalle de una nota.
 *
 * Espejo de `placepos/src/main/database/entities/CreditNoteLine.ts` con
 * extensión multi-tenant (`company_id` denormalizado).
 *
 * --------------------------------------------------------------------------
 * Cuándo se generan
 * --------------------------------------------------------------------------
 *
 *   - `FULL_VOID`: típicamente NO se generan líneas — el total se replica
 *     directo de `sale.total`. Permitimos snapshot opcional de las líneas
 *     originales si el service decide poblarlas.
 *
 *   - `PARTIAL_VOID`: una línea por producto / cantidad anulada.
 *     `original_line_id` referencia `sale_invoice_lines.id` para
 *     trazabilidad y validar que la qty anulada no exceda la qty original.
 *
 *   - `ADDITION` (nota débito): una línea por cargo agregado.
 *
 * --------------------------------------------------------------------------
 * Cálculo (Big.js en el service)
 * --------------------------------------------------------------------------
 *
 *   subtotal   = unit_price * quantity
 *   iva_amount = subtotal * iva_percentage / 100
 *   total      = subtotal + iva_amount
 *
 * Multi-tenancy: `company_id` denormalizado coincidente con
 * `credit_note.company_id` (impuesto por el service al insertar).
 * Cross-tenant guards: `product_id`, `packaging_id` y `original_line_id`
 * deben pertenecer a la company.
 */
@Entity('credit_note_lines')
@Check('chk_credit_note_lines_quantity_positive', 'quantity > 0')
@Check('chk_credit_note_lines_unit_price_non_negative', 'unit_price >= 0')
@Check('chk_credit_note_lines_unit_cost_non_negative', 'unit_cost >= 0')
@Check('chk_credit_note_lines_subtotal_non_negative', 'subtotal >= 0')
@Check(
  'chk_credit_note_lines_iva_percentage_valid',
  'iva_percentage >= 0 AND iva_percentage <= 100',
)
@Check('chk_credit_note_lines_iva_amount_non_negative', 'iva_amount >= 0')
@Check('chk_credit_note_lines_total_non_negative', 'total >= 0')
@Check('chk_credit_note_lines_description_not_empty', 'length(btrim(description)) > 0')
export class CreditNoteLine {
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
  credit_note_id!: string;

  @ManyToOne(() => CreditNote, (n) => n.lines, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'credit_note_id' })
  credit_note!: CreditNote;

  @Column({ type: 'bigint', nullable: true })
  original_line_id!: string | null;

  @ManyToOne(() => SaleInvoiceLine, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'original_line_id' })
  original_line!: SaleInvoiceLine | null;

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

  /**
   * Snapshot del factor de conversión del empaque (`packagings.value`)
   * CONGELADO al momento en que las unidades se comprometieron / devolvieron.
   * El motor de inventario (`adjustInventory`) lo usa como override al aplicar
   * el `RETURN` (NC) o `DEDUCT` (ND); si es `null` (líneas legacy) cae al
   * packaging vigente del producto. Garantiza simetría con el factor con que se
   * descontó el stock — no corrompe inventario si el `value` del empaque cambia.
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
   * FIX #3 — Receta del COMBO CONGELADA, hermana de `packaging_value`. Para una
   * NC viene de la línea de venta que se está devolviendo (así el `RETURN`
   * deshace exactamente el `DEDUCT`); para una ND, de la receta vigente al
   * añadir la línea (que es la que su propio `DEDUCT` aplica). `null` = línea
   * legacy o línea que no vende un combo → el motor usa la receta vigente.
   */
  @Column({ type: 'jsonb', nullable: true })
  combo_recipe!: ComboRecipeSnapshot | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
