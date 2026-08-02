import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';
import { Company } from '@/modules/companies/entities/company.entity';

import { Product } from './product.entity';

/**
 * `combo_components` — receta de un producto COMBO. Espejo de PlacePos
 * (`src/main/database/entities/ComboComponent.ts`) + `company_id` multi-tenant.
 *
 * Un COMBO (`products.product_type = 'COMBO'`) es un producto de nivel raíz
 * (`parent_id` NULL) que no tiene stock propio: se arma con N productos BASE.
 * Cada fila declara cuánto consume el combo de un base concreto.
 *
 * `quantity` va SIEMPRE en la unidad MÍNIMA del componente — la misma en la que
 * vive `products.stock`. Es el equivalente al `packagings.value` de una
 * presentación, pero por componente.
 *
 * Invariantes en DB:
 *   - `quantity > 0` (`chk_combo_components_quantity_positive`).
 *   - `combo_product_id <> component_product_id` (`chk_combo_components_not_self`).
 *   - UNIQUE `(company_id, combo_product_id, component_product_id)`.
 *   - `company_id` CASCADE (barrido total del tenant), combo CASCADE (borrar el
 *     combo borra su receta) y componente NO ACTION (no se puede borrar suelto
 *     un producto que está en una receta, pero la cascada del tenant sí pasa).
 *
 * Multi-tenancy: toda query DEBE filtrar por `company_id`.
 */
@Entity('combo_components')
@Unique('uq_combo_components_combo_component', [
  'company_id',
  'combo_product_id',
  'component_product_id',
])
@Check('chk_combo_components_quantity_positive', 'quantity > 0')
@Check('chk_combo_components_not_self', 'combo_product_id <> component_product_id')
export class ComboComponent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_combo_components_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Index('idx_combo_components_combo')
  @Column({ type: 'bigint', nullable: false })
  combo_product_id!: string;

  @ManyToOne(() => Product, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'combo_product_id' })
  combo!: Product;

  @Index('idx_combo_components_component')
  @Column({ type: 'bigint', nullable: false })
  component_product_id!: string;

  @ManyToOne(() => Product, { onDelete: 'NO ACTION', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'component_product_id' })
  component!: Product;

  /** Cantidad en la unidad MÍNIMA del componente. numeric(15,4). */
  @Column({ type: 'numeric', precision: 15, scale: 4, transformer: NumericTransformer })
  quantity!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
