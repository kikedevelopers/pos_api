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
import { Category } from '@/modules/categories/entities/category.entity';
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
 *   - `stock >= 0` (`chk_products_stock_non_negative`).
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
 * (`inventory.routes.ts`). Migración 1747010520000 reincorporó `stock`,
 * `is_purchasable` y `hash` para alineación byte-por-byte con el cliente
 * Electron. `category_id` ya estaba presente desde la Fase 2A.
 */
@Entity('products')
@Check('chk_products_name_not_empty', 'length(btrim(name)) > 0')
@Check('chk_products_cost_non_negative', 'cost >= 0')
@Check('chk_products_stock_non_negative', 'stock >= 0')
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
   * FK opcional a `categories`. La columna y la FK las crea la migración
   * Fase 2A (`1747009740000-create-categories-table.ts`).
   *
   * ON DELETE SET NULL — archivar / borrar la categoría desliga al producto
   * sin romperlo. Espejo de PlacePos.
   */
  @Column({ type: 'bigint', nullable: true })
  category_id!: string | null;

  @ManyToOne(() => Category, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'category_id' })
  category!: Category | null;

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

  /**
   * Stock unitario. numeric(15,4) — la unidad mínima vendible. Lo persistimos
   * passthrough del cliente. `stock_display` (lo que se muestra al usuario,
   * dividiendo por `packaging.value`) se calcula en la capa de respuesta y
   * no se persiste.
   *
   * Check `stock >= 0` en la migración. Los descuentos por venta o compra
   * deben validar antes de bajar el valor.
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 4,
    default: 0,
    transformer: NumericTransformer,
  })
  stock!: number;

  /**
   * Marca productos comprables (`is_purchasable = true`). Activado por
   * `quick-create` desde el módulo de compras o por toggle manual.
   * Default `false` — un producto nuevo no es comprable hasta que se
   * declare explícitamente.
   */
  @Column({ type: 'boolean', default: false })
  is_purchasable!: boolean;

  /**
   * Hash del producto calculado por el cliente (PlacePos lo genera con
   * `generateProductHash`). Se persiste passthrough — pos_api NUNCA lo
   * recalcula del lado del servidor para no divergir del valor del cliente.
   * NULLABLE para payloads viejos.
   */
  @Column({ type: 'text', nullable: true })
  hash!: string | null;

  /**
   * RUTA del objeto en Google Cloud Storage
   * (`inventory_items/<company_id>/<product_id>-<rnd>.<ext>`), no una URL: la
   * URL se firma al leer y caduca, así que persistirla sería guardar un dato
   * con fecha de vencimiento. La escribe SOLO el servidor (módulo
   * `product-images`); ningún cliente la manda en el payload.
   */
  @Column({ type: 'text', nullable: true })
  image!: string | null;

  /**
   * Instante a partir del cual la imagen puede borrarse del bucket. Se marca al
   * ARCHIVAR el producto (hoy + los días de retención configurados) y un cron
   * diario limpia lo vencido. `null` = sin purga programada, que es el estado de
   * todo producto activo.
   */
  @Column({ type: 'timestamptz', nullable: true })
  image_purge_at!: Date | null;

  /**
   * Si el producto es una COPIA (clonada a una sucursal), la company de ORIGEN
   * (el principal). `null` = producto propio. Lo setea `CloneProductsToBranchAction`.
   * No confundir con compartir: un producto compartido vive en el principal y
   * su `is_shared` se deriva del catálogo, no de esta columna.
   */
  @Column({ type: 'bigint', nullable: true })
  cloned_from_company_id!: string | null;

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
