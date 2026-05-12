import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';

import { ProductPrice } from './product-price.entity';

/**
 * Tipo de producto. Valores PARES con PlacePos (`SIMPLE`/`COMBO`) para
 * paridad byte-por-byte del contrato HTTP. El usuario solicitó
 * `'simple'/'bundle'` pero la regla "espejo de PlacePos" tiene precedencia
 * — divergir rompería el cliente Electron.
 *
 * `enumName: 'product_type'` debe coincidir EXACTAMENTE con el `CREATE TYPE`
 * de la migración.
 */
export enum ProductType {
  SIMPLE = 'SIMPLE',
  COMBO = 'COMBO',
}

/**
 * `products` — Item del catálogo.
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB
 * --------------------------------------------------------------------------
 *
 *   - `name` no en blanco (`chk_products_name_not_empty`).
 *   - `cost >= 0` (`chk_products_cost_non_negative`).
 *   - `parent_id <> id` (anti-self-loop, `chk_products_parent_self_ref`).
 *   - UNIQUE per-company sobre `lower(btrim(name))` para activos
 *     (índice parcial `idx_products_company_name_unique`).
 *   - UNIQUE per-company sobre `sku_code` para activos no-null
 *     (índice parcial `idx_products_company_sku_unique`).
 *   - UNIQUE per-company sobre `bar_code` para activos no-null
 *     (índice parcial `idx_products_company_barcode_unique`).
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * Toda query DEBE filtrar por `company_id`. El service asigna
 * `product.company_id := req.user.company_id`; nunca acepta override
 * del payload. Además valida que `parent_id`/`packaging_id` pertenezcan
 * al mismo tenant antes de insertar.
 *
 * --------------------------------------------------------------------------
 * Paridad de contrato HTTP con PlacePos
 * --------------------------------------------------------------------------
 *
 * El shape de respuesta replica `normalizeProduct` de PlacePos
 * (`inventory.routes.ts`). Los campos OMITIDOS aquí respecto a PlacePos
 * (`stock`, `hash`, `is_purchasable`) se reincorporan en fases posteriores
 * añadiendo columnas — backwards-compatible.
 */
@Entity('products')
@Check('chk_products_name_not_empty', 'length(btrim(name)) > 0')
@Check('chk_products_cost_non_negative', 'cost >= 0')
@Check('chk_products_parent_self_ref', 'parent_id IS NULL OR parent_id <> id')
export class Product {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /**
   * Tenant. Mapeado como `string` porque pg devuelve bigint como string.
   */
  @Index('idx_products_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: ProductType,
    enumName: 'product_type',
    default: ProductType.SIMPLE,
  })
  product_type!: ProductType;

  /**
   * FK reflexiva (combo padre). `null` para producto raíz. Mapeado como
   * `string | null` por la convención bigint→string.
   */
  @Column({ type: 'bigint', nullable: true })
  parent_id!: string | null;

  @ManyToOne(() => Product, (p) => p.children, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'parent_id' })
  parent!: Product | null;

  @OneToMany(() => Product, (p) => p.parent)
  children!: Product[];

  @Column({ type: 'text', nullable: true })
  sku_code!: string | null;

  @Column({ type: 'text', nullable: true })
  bar_code!: string | null;

  @Column({ type: 'bigint', nullable: true })
  packaging_id!: string | null;

  @ManyToOne(() => Packaging, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'packaging_id' })
  packaging!: Packaging | null;

  /**
   * Costo unitario. numeric(15,2). Dentro del service, vuélvelo a `Big`
   * antes de calcular profit/margin.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  cost!: number;

  @Column({ type: 'text', nullable: true })
  image!: string | null;

  @Column({ type: 'boolean', default: true })
  show_in_pos!: boolean;

  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @Column({ type: 'text', nullable: true })
  updated_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  updated_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @OneToMany(() => ProductPrice, (pp) => pp.product)
  prices!: ProductPrice[];
}
