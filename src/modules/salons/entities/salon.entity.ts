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

import { Company } from '@/modules/companies/entities/company.entity';
import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';

/**
 * `salons` — Un salón AGRUPA mesas (es como una categoría de mesas, p. ej.
 * "Sur A"). Capacidad cloud-only del modo restaurante. Solo tiene nombre; no
 * modela aforo ni capacidad.
 *
 * Multi-tenancy: toda query filtra por `company_id` (asignado desde
 * `req.user.company_id`, nunca del payload). UNIQUE per-company parcial sobre
 * `lower(btrim(name))` donde `is_archived = false` (archivar libera el nombre).
 */
@Entity('salons')
@Check('chk_salons_name_not_empty', 'length(btrim(name)) > 0')
export class Salon {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_salons_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text', nullable: false })
  name!: string;

  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  /** Mesas del salón (ancladas). El lado dueño de la FK es RestaurantTable. */
  @OneToMany(() => RestaurantTable, (table) => table.salon)
  tables!: RestaurantTable[];

  /** Snapshot del full_name del actor que creó el salón. */
  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  /** ID del actor creador. Sin FK formal — informacional. */
  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
