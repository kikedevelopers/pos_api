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
 * `delivery_companies` — Empresa/persona domiciliaria (transportadora de
 * domicilios) de una company.
 *
 * Espejo del feature "Domiciliarios" de PlacePos con extensión multi-tenant
 * (`company_id` NOT NULL).
 *
 * --------------------------------------------------------------------------
 * Modelado
 * --------------------------------------------------------------------------
 *
 *   - `phones` se persiste como `jsonb DEFAULT '[]'` (array de strings). Se
 *     valida máx 4 teléfonos en el DTO. Siempre se expone como `string[]`.
 *   - `is_archived` boolean — convención PlacePos para soft-delete (igual que
 *     bancos, billeteras, proveedores). A diferencia de `suppliers` (que solo
 *     archiva), aquí exponemos archive + unarchive (contrato Domiciliarios).
 *
 * --------------------------------------------------------------------------
 * Invariantes
 * --------------------------------------------------------------------------
 *
 *   - `name` no-blank (CHECK).
 *   - `(company_id, name)` indexado para búsquedas/orden por nombre.
 */
@Entity('delivery_companies')
@Check('chk_delivery_companies_name_not_empty', 'length(btrim(name)) > 0')
export class DeliveryCompany {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_delivery_companies_company_id')
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

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  /**
   * Lista de teléfonos. `jsonb` con default `'[]'`. Máx 4 (validado en DTO).
   * El driver `pg` entrega/recibe el valor ya parseado como `string[]`.
   */
  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  phones!: string[];

  @Column({ type: 'boolean', nullable: false, default: false })
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
