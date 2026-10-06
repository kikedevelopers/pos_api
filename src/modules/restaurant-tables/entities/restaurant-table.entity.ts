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
import { Salon } from '@/modules/salons/entities/salon.entity';

/** Estado de ocupación de una mesa. Preparado para el flujo de pedidos. */
export const RESTAURANT_TABLE_STATUSES = ['free', 'occupied'] as const;
export type RestaurantTableStatus = (typeof RESTAURANT_TABLE_STATUSES)[number];

/**
 * `restaurant_tables` — Una mesa del restaurante. Tiene `name` + `seats` (nº de
 * sillas) y, opcionalmente, pertenece a un salón (`salon_id`).
 *
 * Anclaje (`owned_by_salon`):
 *   - `true`  → la mesa se CREÓ dentro del salón; anclada permanentemente. Se
 *     archiva junto con el salón.
 *   - `false` → mesa EXISTENTE anclada a un salón; al archivar el salón solo se
 *     desancla (`salon_id = null`) y queda suelta.
 *
 * `status` ('free' | 'occupied', default 'free') queda listo para el flujo de
 * pedidos: una mesa se ocupa al recibir un pedido y se libera al cobrarlo. Este
 * módulo solo administra el CRUD.
 */
@Entity('restaurant_tables')
@Check('chk_restaurant_tables_name_not_empty', 'length(btrim(name)) > 0')
@Check('chk_restaurant_tables_seats_positive', 'seats > 0')
export class RestaurantTable {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_restaurant_tables_company_id')
  @Column({ type: 'bigint', nullable: false })
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'text', nullable: false })
  name!: string;

  @Column({ type: 'integer', default: 1 })
  seats!: number;

  /**
   * Salón al que está anclada, o `null` si está suelta. El índice parcial
   * (`idx_restaurant_tables_salon_id WHERE salon_id IS NOT NULL`) vive solo en
   * la migración, como el resto de índices parciales del repo (declararlo aquí
   * sin el `where` provocaría un diff espurio en migration:generate).
   */
  @Column({ type: 'bigint', nullable: true })
  salon_id!: string | null;

  @ManyToOne(() => Salon, (salon) => salon.tables, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'salon_id' })
  salon!: Salon | null;

  /** `true` = creada dentro del salón (anclaje permanente); `false` = anclada. */
  @Column({ type: 'boolean', default: false })
  owned_by_salon!: boolean;

  @Column({
    type: 'enum',
    enum: RESTAURANT_TABLE_STATUSES,
    enumName: 'restaurant_tables_status_enum',
    default: 'free',
  })
  status!: RestaurantTableStatus;

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
