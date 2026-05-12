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

import { Product } from './product.entity';

/**
 * `product_prices` — Un nivel de precio por producto (ej. "Detal", "Mayor").
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB
 * --------------------------------------------------------------------------
 *
 *   - `sale_price >= 0` (`chk_product_prices_sale_price_non_negative`).
 *   - `iva_percentage ∈ [0, 100]`
 *     (`chk_product_prices_iva_percentage_valid`).
 *
 * --------------------------------------------------------------------------
 * `company_id` denormalizado
 * --------------------------------------------------------------------------
 *
 * El precio "ya conoce" su company a través de `product.company_id`. Pero
 * añadimos la columna explícita aquí para:
 *
 *   1. Filtrar por company sin JOIN (queries calientes en dashboard /
 *      reportes que agregan precios).
 *   2. Cumplir multi-tenant-rules §1 (toda tabla transaccional lleva
 *      `company_id`).
 *
 * Coherencia (`product_prices.company_id === products.company_id`) es
 * responsabilidad del service: al crear/actualizar, copia el `company_id`
 * desde el product en la misma transacción.
 *
 * --------------------------------------------------------------------------
 * Cálculo de profit y margin
 * --------------------------------------------------------------------------
 *
 * `profit` y `margin` se calculan en el service con Big.js
 * (`calculateProfit` / `calculateMargin`). El DTO acepta valores hint del
 * cliente pero el service los RECALCULA siempre — fuente única de verdad.
 */
@Entity('product_prices')
@Check('chk_product_prices_sale_price_non_negative', 'sale_price >= 0')
@Check('chk_product_prices_iva_percentage_valid', 'iva_percentage >= 0 AND iva_percentage <= 100')
export class ProductPrice {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_product_prices_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Index('idx_product_prices_product_id')
  @Column({ type: 'bigint', nullable: false })
  product_id!: string;

  @ManyToOne(() => Product, (p) => p.prices, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  @Column({ type: 'text', default: '' })
  name!: string;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  sale_price!: number;

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

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  iva_percentage!: number;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
