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
 * `carriers` — Transportista (proveedor de flete) per-company.
 *
 * --------------------------------------------------------------------------
 * Paridad PlacePos
 * --------------------------------------------------------------------------
 *
 *   Espejo de la entidad local + extensión `company_id` para cloud. La deuda
 *   pendiente NO se almacena aquí: se calcula desde `carrier_credits.balance`
 *   en `find-all-carriers` y `get-carriers-analytics`. Mantener un sumatorio
 *   denormalizado en `carriers` introduciría drift entre la suma real y el
 *   cacheado — peor que hacer el JOIN.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   Toda query DEBE filtrar por `company_id`. UNIQUE parcial per-company
 *   sobre `lower(btrim(name))` cuando `is_archived = false`.
 */
@Entity('carriers')
@Check('chk_carriers_name_not_empty', 'length(btrim(name)) > 0')
export class Carrier {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_carriers_company_id')
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
  identification!: string | null;

  @Column({ type: 'text', nullable: true })
  phone!: string | null;

  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
