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
import { Product } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';

import { ProductCostHistory } from './product-cost-history.entity';

/**
 * `product_price_history` — Auditoría inmutable de cambios de
 * `sale_price`/`profit`/`margin` en un `product_prices`.
 *
 * `cost_history_id` enlaza al row de `product_cost_history` que originó
 * el recálculo (cuando aplica). El JOIN se usa en el listado:
 * `GET /product-prices/:id/price-history` para traer `purchase_id` y
 * `event_type` correlacionados.
 *
 * Fase 2A: tabla creada; populate en Fase 5+.
 */
@Entity('product_price_history')
export class ProductPriceHistory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_pph_company_id')
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
  product_price_id!: string;

  @ManyToOne(() => ProductPrice, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'product_price_id' })
  product_price!: ProductPrice;

  @Column({ type: 'bigint', nullable: false })
  product_id!: string;

  @ManyToOne(() => Product, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  @Column({ type: 'bigint', nullable: true })
  cost_history_id!: string | null;

  @ManyToOne(() => ProductCostHistory, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'cost_history_id' })
  cost_history!: ProductCostHistory | null;

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
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  profit_before!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  profit_after!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  margin_before!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  margin_after!: number;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
