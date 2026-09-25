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

/**
 * `customer_categories` — Agrupador ESPECIAL de clientes (p. ej. "Cliente
 * Redes Sociales", "Clientes Pueblos"). Es una capacidad cloud-only: PlacePos
 * local no modela categorías de cliente (paridad suspendida — el offline no la
 * usa).
 *
 * Estructuralmente es un espejo de `categories` (agrupador del catálogo de
 * productos), con una diferencia deliberada pedida por el negocio: guarda
 * AUDITORÍA de quién la creó (`created_by` / `created_by_id`), como hace
 * `customers`. Las categorías de PRODUCTO no la guardan; las de CLIENTE sí.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   Toda query DEBE filtrar por `company_id`. El service asigna
 *   `company_id := req.user.company_id`; nunca acepta override del payload.
 *
 * --------------------------------------------------------------------------
 * UNIQUE per-company (parcial)
 * --------------------------------------------------------------------------
 *
 *   `idx_customer_categories_company_name_unique` cubre
 *   `(company_id, lower(btrim(name)))` solo para `is_archived = false`.
 *   Archivar libera el nombre.
 */
@Entity('customer_categories')
@Check('chk_customer_categories_name_not_empty', 'length(btrim(name)) > 0')
export class CustomerCategory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_customer_categories_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text', nullable: false })
  name!: string;

  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  /**
   * Snapshot del `full_name` del actor (User u Employee) que creó la
   * categoría. Texto congelado al momento de creación. Espejo del patrón de
   * `customers.created_by`.
   */
  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  /**
   * ID del actor creador. Sin FK formal — campo informacional. Mapeado como
   * `string | null` porque pg devuelve bigint como string.
   */
  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
