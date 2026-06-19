import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import { Product } from './product.entity';

/**
 * `inventory_shares` — FASE 2 (COMPARTIR).
 *
 * Una fila declara que el negocio PRINCIPAL (`source_company_id`) comparte
 * inventario con una SUCURSAL (`target_company_id`):
 *   - `product_id IS NULL` → comparte TODO el catálogo (share company-level).
 *   - `product_id` no-null → comparte ese producto (share product-level).
 *
 * El producto sigue siendo del principal: compartir es solo lectura/venta en
 * la sucursal. El stock vive en la fila del principal (única fuente de verdad).
 */
@Entity('inventory_shares')
export class InventoryShare {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_inventory_shares_source_target_entity')
  @Column({ type: 'bigint', nullable: false })
  source_company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'RESTRICT', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'source_company_id' })
  source_company!: Company;

  @Index('idx_inventory_shares_target_company_id_entity')
  @Column({ type: 'bigint', nullable: false })
  target_company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'RESTRICT', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'target_company_id' })
  target_company!: Company;

  /** NULL = comparte TODO el catálogo del source; no-null = producto específico. */
  @Column({ type: 'bigint', nullable: true })
  product_id!: string | null;

  @ManyToOne(() => Product, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'product_id' })
  product!: Product | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
