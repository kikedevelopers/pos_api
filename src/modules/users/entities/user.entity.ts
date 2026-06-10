import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { NumericTransformer } from '@/common/utils/numeric-transformer';

import { Company } from '@/modules/companies/entities/company.entity';

/**
 * Enum de tipos de usuario.
 *
 *   - `SUPERADMIN`: usuario global del sistema, NO pertenece a ninguna
 *     company.
 *   - `OWNER`: dueño de una company, único creado por `POST /auth/register`.
 *   - `EMPLOYEE`: **User espejo** de un Employee con `login_enabled=true`
 *     (patrón Fase 4A). El rol granular del Employee (`manager` |
 *     `employee`) vive en `employees.role`; el `User` solo expone `type=
 *     'employee'` literal para satisfacer el contrato PlacePos y para que
 *     los modelos atados a `users.id` (cash_register, cash_register_log,
 *     financial_movement.created_by_id) puedan apuntar a una identidad
 *     concreta.
 *
 * El `enumName: 'user_type'` debe coincidir EXACTAMENTE con el `CREATE TYPE`
 * de la migración. Si difiere, TypeORM crearía un tipo paralelo. El valor
 * `'employee'` se añade vía
 * `1747010320000-extend-user-type-enum-with-employee.ts`.
 */
export enum UserType {
  SUPERADMIN = 'superadmin',
  OWNER = 'owner',
  EMPLOYEE = 'employee',
}

/**
 * `users` — Cuenta de login de tipo Owner o Superadmin.
 *
 * Reglas de integridad enforced en DB (CHECK constraint):
 *   - type = 'superadmin' => company_id IS NULL
 *   - type = 'owner'      => company_id IS NOT NULL
 *
 * El service NO puede violarlas: la DB rechazará el INSERT/UPDATE. Esta es
 * la defensa final contra bugs de lógica en el código de aplicación.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  lastname!: string;

  /**
   * Identificador de login. UNIQUE GLOBAL (no per-company) porque el
   * endpoint `POST /auth/user` no conoce la company hasta resolver el
   * usuario. El espacio de emails es plano entre tenants.
   */
  @Index('idx_users_email_unique', { unique: true })
  @Column({ type: 'text' })
  email!: string;

  /**
   * Hash argon2id aplicado por el AuthService al registrar/cambiar.
   * La columna no impone formato; el servicio garantiza la invariante.
   */
  @Column({ type: 'text' })
  password!: string;

  @Column({ type: 'enum', enum: UserType, enumName: 'user_type' })
  type!: UserType;

  /**
   * Balance personal del owner. Espejo de PlacePos. Para `superadmin`
   * permanece en 0 (sin uso por ahora).
   */
  @Column({
    type: 'numeric',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: NumericTransformer,
  })
  balance!: number;

  /**
   * Tenant al que pertenece el usuario.
   *
   *   - `owner`     => NOT NULL (enforced por CHECK)
   *   - `superadmin`=> NULL     (enforced por CHECK)
   *
   * Mapeado como `string | null` porque pg devuelve bigint como string.
   */
  @Index('idx_users_company_id')
  @Column({ type: 'bigint', nullable: true })
  company_id!: string | null;

  @ManyToOne(() => Company, (company) => company.users, {
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company | null;

  /**
   * Multi-sucursal — gating administrativo (lo controla el admin desde
   * kdevs-admin, no el propio owner):
   *   - `branches_enabled`: si la cuenta puede usar sucursales.
   *   - `branches_allowed`: cuántas sucursales puede crear (>= 0). La regla
   *     `enabled ⇒ allowed >= 1` se valida en el action, no en DB.
   */
  @Column({ type: 'boolean', default: false })
  branches_enabled!: boolean;

  @Column({ type: 'integer', default: 0 })
  branches_allowed!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
