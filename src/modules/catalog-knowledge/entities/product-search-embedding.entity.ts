import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { Product } from '@/modules/products/entities/product.entity';

/**
 * `product_search_embeddings` — vector de significado de una FAMILIA (producto
 * base + presentaciones + ficha) para buscar por necesidad. Normalizado (norma
 * 1): la similitud coseno es el producto punto.
 */
@Entity('product_search_embeddings')
@Index('idx_product_search_embeddings_product_unique', ['product_id'], { unique: true })
@Index('idx_product_search_embeddings_company', ['company_id'])
export class ProductSearchEmbeddingEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Producto BASE de la familia. */
  @Column({ type: 'bigint' })
  product_id!: string;

  @ManyToOne(() => Product, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  @Column({ type: 'varchar', length: 64 })
  model!: string;

  /** SHA-256 del texto indexado: si cambia, se recalcula el vector. */
  @Column({ type: 'char', length: 64 })
  text_hash!: string;

  @Column({ type: 'real', array: true })
  embedding!: number[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
