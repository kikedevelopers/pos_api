import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';

import { User } from '@/modules/users/entities/user.entity';

/**
 * Origen de creación de la company.
 *
 *   - `web`: registro normal vía `POST /auth/register` (web/cloud directo).
 *   - `offline_migration`: la cuenta cloud se creó DESDE un POS offline
 *     (`placepos`) en su primera migración a "modo cloud". Estas cuentas
 *     arrancan con un trial más corto (`SUBSCRIPTION_MIGRATION_DAYS`).
 */
export type CompanyOrigin = 'web' | 'offline_migration';

/**
 * `companies` — Tenant raíz del sistema multi-tenant.
 *
 * No lleva `owner_id` (divergencia intencional vs PlacePos): el owner se
 * resuelve por `users.company_id` + `users.type = 'owner'`. Esto rompe el
 * ciclo de FK y permite que `POST /auth/register` cree Company y User en
 * una sola transacción sin deferred constraints.
 *
 * `id` se mapea a `string` en TypeORM porque pg devuelve `bigint` como
 * string (un `number` JS no cubre 2^53+1). El service convertirá a number
 * cuando lo serialice a JSON para mantener el contrato PlacePos (ids
 * numéricos), o lo dejará como string si el flujo así lo requiere.
 */
@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('idx_companies_name')
  @Column({ type: 'text' })
  name!: string;

  /**
   * RIF/NIT/CUIT/RFC. Sin UNIQUE global por variabilidad de formatos
   * entre países y posibilidad legítima de duplicados.
   */
  @Column({ type: 'text', nullable: true })
  document_number!: string | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  balance!: number;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  /** Email de contacto del negocio. Distinto del email del owner. */
  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ type: 'text', nullable: true })
  phone_number!: string | null;

  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  break_even_amount!: number;

  @Column({ type: 'integer', default: 30 })
  break_even_period_days!: number;

  /**
   * Origen de la cuenta: `'web'` (registro normal) | `'offline_migration'`
   * (creada desde un POS offline en su primera migración a cloud). Default
   * `'web'` en DB para que las companies existentes queden marcadas como
   * registro normal sin necesidad de backfill explícito.
   */
  @Column({ type: 'varchar', length: 32, default: 'web' })
  origin!: CompanyOrigin;

  /**
   * Multi-sucursal: `false` para el primer negocio del owner (registro normal),
   * `true` para cada sucursal creada después vía `POST /branches`. Solo
   * informativo/UI y base para el cobro futuro por sucursal — el aislamiento de
   * datos lo sigue garantizando `company_id`, no este flag. Default `false` en
   * DB para que las companies existentes queden como negocio principal sin
   * backfill.
   */
  @Column({ type: 'boolean', default: false })
  is_branch!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  /**
   * Relación inversa hacia los usuarios de la company (siempre incluirá
   * al `owner` y, en fases siguientes, cualquier extensión). Se declara
   * con `() => User` para tolerar el import circular potencial; el
   * Architect podrá eager-load donde sea necesario.
   */
  @OneToMany(() => User, (user) => user.company)
  users!: User[];
}
