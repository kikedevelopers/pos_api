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
import { Role } from '@/modules/roles/entities/role.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Roles operativos de un empleado dentro de una company.
 *
 *   - `manager`: gestión amplia dentro de su company (excepto admin de
 *     empresa, reservado al `owner`).
 *   - `employee`: operación de POS (ventas, caja, etc.).
 *
 * El `enumName: 'employee_role'` debe coincidir EXACTAMENTE con el `CREATE TYPE`
 * de la migración. Si difiere, TypeORM crearía un tipo paralelo.
 *
 * NOTA: este enum es independiente de `UserType` (que vive en `users`).
 * `User` y `Employee` son entidades distintas con jerarquías de rol
 * separadas, según CLAUDE.md §2.7.
 */
export enum EmployeeRole {
  MANAGER = 'manager',
  EMPLOYEE = 'employee',
}

/**
 * `employees` — Sub-usuario creado por un `owner` para operar el POS.
 *
 * --------------------------------------------------------------------------
 * EXCEPCIÓN INTENCIONAL a `multi-tenant-rules`: `username` UNIQUE GLOBAL
 * --------------------------------------------------------------------------
 *
 * `username` lleva un UNIQUE GLOBAL (no compuesto con `company_id`), análogo
 * a `users.email`. Razón: es identificador de AUTENTICACIÓN, no de negocio.
 * El endpoint `POST /auth/user` recibe `{ username, password }` sin tenant —
 * si el username fuera unique-por-company, el login sería ambiguo.
 *
 * El índice subyacente es PARCIAL (`WHERE username IS NOT NULL`) para
 * permitir múltiples employees sin login configurado todavía. Ver migración
 * `1747008120000-create-employees-table.ts`.
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB (CHECK constraints)
 * --------------------------------------------------------------------------
 *
 *   - `login_enabled = true`  =>  `username NOT NULL` AND `password NOT NULL`
 *     (`chk_employees_login_requires_credentials`)
 *   - `username` no puede ser cadena en blanco si no es NULL
 *     (`chk_employees_username_not_empty`)
 *   - `name` no puede ser cadena en blanco
 *     (`chk_employees_name_not_empty`)
 *
 * El service NO puede violarlas: la DB rechaza el INSERT/UPDATE.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * Toda query DEBE filtrar por `company_id`. El service asigna
 * `employee.company_id := req.user.company_id`; nunca acepta override del
 * payload. La coherencia cross-tenant del creador (que `users.company_id` del
 * owner === `employees.company_id`) es responsabilidad del service, no de la
 * DB (ver JSDoc de la migración).
 */
@Entity('employees')
@Check(
  'chk_employees_login_requires_credentials',
  `(login_enabled = false)
   OR (username IS NOT NULL AND password IS NOT NULL AND length(btrim(username)) > 0)`,
)
@Check('chk_employees_username_not_empty', 'username IS NULL OR length(btrim(username)) > 0')
@Check('chk_employees_name_not_empty', 'length(btrim(name)) > 0')
export class Employee {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /**
   * Tenant al que pertenece el employee. Asignado por el service desde
   * `req.user.company_id`; nunca aceptado del payload del cliente.
   *
   * Mapeado como `string` porque pg devuelve bigint como string.
   */
  @Index('idx_employees_company_id')
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
  phone!: string | null;

  /**
   * Email de CONTACTO, NO de autenticación. El login del employee usa
   * `username`. Puede ser NULL.
   */
  @Column({ type: 'text', nullable: true })
  email!: string | null;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ type: 'enum', enum: EmployeeRole, enumName: 'employee_role' })
  role!: EmployeeRole;

  @Column({ type: 'boolean', default: false })
  login_enabled!: boolean;

  /**
   * Identificador de login. UNIQUE GLOBAL parcial (índice creado en la
   * migración con `WHERE username IS NOT NULL`). NULL cuando aún no se
   * asignan credenciales al employee.
   *
   * No anotamos `@Index` aquí porque TypeORM no genera índices parciales
   * con condición `WHERE` desde decoradores; el índice vive como SQL
   * crudo en la migración.
   */
  @Column({ type: 'text', nullable: true })
  username!: string | null;

  /**
   * Hash argon2id aplicado por el AuthService al asignar/cambiar
   * credenciales. La columna no impone formato; el service garantiza la
   * invariante. NULL cuando aún no se asignan credenciales.
   */
  @Column({ type: 'text', nullable: true })
  password!: string | null;

  /**
   * Soft-delete convención PlacePos. Listados activos filtran
   * `is_archived = false`. Cubierto por índice parcial
   * `idx_employees_company_active`.
   */
  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  /**
   * Permiso por-empleado para ver márgenes y ganancias en el POS/reportes.
   * Nace en false; solo un administrador (owner) lo cambia desde el detalle del
   * empleado (`PUT /employees/:id/profit-visibility`). Paridad PlacePos.
   */
  @Column({ type: 'boolean', default: false })
  can_view_profit!: boolean;

  /**
   * Permiso por-empleado para ver el saldo y el historial de caja en el POS.
   * Nace en false; al asignar el rol "Cajero" se activa por defecto (transición
   * de rol), pero el admin puede desactivarlo (`PUT /employees/:id/cash-visibility`).
   * Owner/superadmin siempre ven la caja. Paridad PlacePos.
   */
  @Column({ type: 'boolean', default: false })
  can_view_cash!: boolean;

  /**
   * Subpermisos de `can_view_profit`: controlan de forma granular si el empleado
   * ve el Margen (%) y la Ganancia ($) en el configurador de producto del POS
   * (ProductConfigurator). Nacen en false; el back-fill de la migración los
   * iguala a `can_view_profit`. Owner/superadmin siempre ven ambos. El toggle
   * principal del detalle cascada su valor a ambos. Paridad PlacePos.
   */
  @Column({ type: 'boolean', default: false })
  can_view_product_margin!: boolean;

  @Column({ type: 'boolean', default: false })
  can_view_product_profit!: boolean;

  /**
   * Snapshot del `full_name` del owner que creó al employee. Texto
   * congelado al momento de creación (no se actualiza si el owner cambia
   * su nombre). Evita un join para el listado.
   */
  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  /**
   * ID del owner creador. Sin FK formal — campo informacional. Mapeado
   * como `string | null` porque pg devuelve bigint como string.
   *
   * Ver JSDoc de la migración para la justificación de la ausencia de FK.
   */
  @Column({ type: 'bigint', nullable: true })
  created_by_id!: string | null;

  /**
   * FK al `User` espejo (`users.type='employee'`) que representa a este
   * Employee para los modelos atados a `users.id` (cash_register,
   * cash_register_log, financial_movement.created_by_id).
   *
   * Se crea on-demand en login/create/toggle-login. NULL hasta el primer
   * login (o hasta que el owner habilite el login del Employee).
   *
   * UNIQUE parcial `(user_id) WHERE user_id IS NOT NULL`: un User es
   * espejo de a lo más un Employee. Ver migración
   * `1747010340000-add-user-id-to-employees.ts`.
   */
  @Column({ type: 'bigint', nullable: true })
  user_id!: string | null;

  @ManyToOne(() => User, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  /**
   * FK al rol PERSONALIZADO (`roles.id`) que define los módulos accesibles del
   * empleado (FASE 1, modelo de datos). NULL = sin rol personalizado asignado
   * (cae al control por rol fijo legacy hasta Fase 2). Mapeado como
   * `string | null` porque pg devuelve bigint como string.
   *
   * FK `ON DELETE SET NULL`: borrar un rol desasigna a sus empleados, no los
   * borra. Índice parcial-no, índice plano `idx_employees_role_id` en la
   * migración `1747011860000-add-role-id-to-employees.ts`.
   */
  @Index('idx_employees_role_id')
  @Column({ type: 'bigint', nullable: true })
  role_id!: string | null;

  @ManyToOne(() => Role, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'role_id' })
  customRole!: Role | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
