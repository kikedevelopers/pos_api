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
 * `categories` — Agrupador del catálogo. Espejo del `Category` de PlacePos.
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
 *   `idx_categories_company_name_unique` cubre `(company_id, lower(btrim(name)))`
 *   solo para `is_archived = false`. Archivar libera el nombre.
 */
@Entity('categories')
@Check('chk_categories_name_not_empty', 'length(btrim(name)) > 0')
export class Category {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_categories_company_id')
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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
