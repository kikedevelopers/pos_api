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

import { Company } from '@/modules/companies/entities/company.entity';
import { Product } from '@/modules/products/entities/product.entity';

import type { ProductAttribute, RelatedProductRef } from '../internal/profile';

/**
 * `product_assistant_profiles` — ficha "Para el asistente" de un producto BASE
 * (sus presentaciones la heredan). Le da contexto al vendedor IA para responder
 * "¿tienes algo que me sirva para X?".
 */
@Entity('product_assistant_profiles')
@Index('idx_product_assistant_profiles_product_unique', ['product_id'], { unique: true })
@Index('idx_product_assistant_profiles_company', ['company_id'])
@Check('chk_product_assistant_profiles_description_len', 'length(description) <= 1000')
export class ProductAssistantProfileEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint' })
  product_id!: string;

  @ManyToOne(() => Product, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  /** Qué es el producto, en lenguaje de cliente. */
  @Column({ type: 'text', default: '' })
  description!: string;

  /** Para qué sirve (etiquetas cortas: "hamburguesa con papas", "domicilio"). */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  uses!: string[];

  /** Características clave-valor ("compartimentos: 2", "material: icopor"). */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  attributes!: ProductAttribute[];

  /** Cómo lo llaman los clientes ("portacomida", "coca"). */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  aliases!: string[];

  /** Productos relacionados: complemento, versión superior o alternativa. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  related!: RelatedProductRef[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
