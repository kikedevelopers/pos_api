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
import { Purchase } from '@/modules/purchases/entities/purchase.entity';

/**
 * Tipo de evento que originó la entrada de historial de costo.
 */
export enum ProductCostHistoryEvent {
  RECEIVE = 'RECEIVE',
  EDIT = 'EDIT',
  ARCHIVE = 'ARCHIVE',
}

/**
 * Origen del recálculo del costo.
 */
export enum ProductCostHistoryDerivedFrom {
  PURCHASE = 'PURCHASE',
  PARENT = 'PARENT',
}

/**
 * `product_cost_history` — Auditoría inmutable de cambios de costo.
 *
 * Multi-tenancy: `company_id` denormalizado para indexar sin join.
 *
 * Fase 2A: estructura creada; los INSERTs ocurren en Fase 5+ desde
 * `purchaseReceiveOperations`. Los GET endpoints devuelven listas vacías
 * mientras tanto.
 */
@Entity('product_cost_history')
export class ProductCostHistory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_pch_company_id')
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
  product_id!: string;

  @ManyToOne(() => Product, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  @Column({ type: 'bigint', nullable: true })
  purchase_id!: string | null;

  @ManyToOne(() => Purchase, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'purchase_id' })
  purchase!: Purchase | null;

  @Column({
    type: 'enum',
    enum: ProductCostHistoryEvent,
    enumName: 'product_cost_history_event',
  })
  event_type!: ProductCostHistoryEvent;

  @Column({
    type: 'enum',
    enum: ProductCostHistoryDerivedFrom,
    enumName: 'product_cost_history_source',
  })
  derived_from!: ProductCostHistoryDerivedFrom;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  cost_before!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  cost_after!: number;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  change_pct!: number;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
