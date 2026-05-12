import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 2 — Crea el tipo enum `employee_role` y la tabla `employees`.
 *
 * Contexto del dominio (ver CLAUDE.md §2.7):
 *
 *   `Employee` es una entidad SEPARADA de `User`. Representa al personal
 *   contratado por el `owner` de una company para operar el POS. Los roles
 *   operativos `manager` y `employee` viven aquí, NO en `users.user_type`.
 *
 *   El login (`POST /auth/user`) busca primero en `users` por email y luego
 *   en `employees` por username. Si el match es un `Employee`, el JWT lleva
 *   `account = 'employee'` y `type = employee.role`.
 *
 * --------------------------------------------------------------------------
 * EXCEPCIÓN INTENCIONAL A `multi-tenant-rules`: `username` UNIQUE GLOBAL
 * --------------------------------------------------------------------------
 *
 * La skill `multi-tenant-rules` indica que los unique constraints deben ser
 * COMPUESTOS con `company_id`. Aquí declaramos `employees.username` UNIQUE
 * GLOBAL (no compuesto con company_id), análogo a `users.email`.
 *
 * Razón: `username` es un identificador de AUTENTICACIÓN, no de negocio. El
 * endpoint `POST /auth/user` recibe únicamente `{ username, password }` —
 * NO conoce el `company_id` hasta resolver el employee. Si el username
 * fuera unique-por-company, dos employees de companies distintas podrían
 * tener el mismo username y el login sería ambiguo.
 *
 * Implicación operativa: los owners eligen usernames únicos a nivel global
 * (típicamente con prefijo del negocio, p.ej. `kike-bodegonares`).
 *
 * Esta divergencia se contiene a una sola columna y se justifica del mismo
 * modo que `users.email` UNIQUE GLOBAL en Fase 0.
 *
 * --------------------------------------------------------------------------
 * `created_by` / `created_by_id` — sin FK formal (Opción A)
 * --------------------------------------------------------------------------
 *
 * Elegimos NO declarar FK desde `employees.created_by_id` hacia `users.id`.
 * Razones:
 *
 *   1. `created_by_id` es informacional/auditoría. Si el owner que creó al
 *      employee fuera borrado (cosa que `ON DELETE RESTRICT` en companies
 *      previene de facto, pero quede como defensa), el employee no debe
 *      verse afectado.
 *
 *   2. `created_by` (text) congela el `full_name` del owner al momento de
 *      creación. Aunque el owner cambie su nombre después, el registro
 *      histórico se preserva sin un join costoso.
 *
 *   3. Espejamos el comportamiento de PlacePos (que también omite la FK
 *      formal en su `Employee`).
 *
 * Si en el futuro necesitamos navegabilidad fuerte (ej. listar todos los
 * employees creados por un usuario), añadimos la FK con una migración nueva.
 *
 * --------------------------------------------------------------------------
 * Coherencia cross-tenant del creador
 * --------------------------------------------------------------------------
 *
 * NO existe CHECK constraint que valide que `users.company_id` del creador
 * coincida con `employees.company_id`. Esa invariante es responsabilidad
 * del service (el cual debe asignar `employee.company_id := req.user.company_id`
 * sin permitir override del payload). Documentado para que el
 * `security-auditor` lo valide.
 *
 * --------------------------------------------------------------------------
 * Constraint clave: `chk_employees_login_requires_credentials`
 * --------------------------------------------------------------------------
 *
 * Garantiza la invariante:
 *
 *   login_enabled = true  =>  username NOT NULL AND password NOT NULL
 *
 * Defensa de última línea contra bugs del service que pudieran habilitar
 * el login sin asignar credenciales (escenario peligroso: cuenta con
 * login pero sin password → AuthService podría comportarse erráticamente).
 */
export class CreateEmployeesTable1747008120000 implements MigrationInterface {
  name = 'CreateEmployeesTable1747008120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum nativo de Postgres.
    await queryRunner.query(`
      CREATE TYPE employee_role AS ENUM ('manager', 'employee')
    `);

    // 2. Tabla employees.
    await queryRunner.createTable(
      new Table({
        name: 'employees',
        columns: [
          {
            name: 'id',
            type: 'bigserial',
            isPrimary: true,
          },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'Tenant al que pertenece el employee. Asignado por el service desde req.user.company_id; nunca aceptado del payload.',
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'phone',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'email',
            type: 'text',
            isNullable: true,
            comment:
              'Email de contacto, NO de autenticación. El login del employee usa `username`.',
          },
          {
            name: 'address',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'role',
            type: 'employee_role',
            isNullable: false,
            enumName: 'employee_role',
          },
          {
            name: 'login_enabled',
            type: 'boolean',
            isNullable: false,
            default: false,
          },
          {
            name: 'username',
            type: 'text',
            isNullable: true,
            comment:
              'Identificador de login (UNIQUE GLOBAL parcial). NULL si el employee aún no tiene credenciales asignadas.',
          },
          {
            name: 'password',
            type: 'text',
            isNullable: true,
            comment:
              'Hash argon2id aplicado por el AuthService. NULL si aún no se asignan credenciales.',
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment: 'Soft-delete convención PlacePos. Filtro implícito en listados activos.',
          },
          {
            name: 'created_by',
            type: 'text',
            isNullable: true,
            comment:
              'Snapshot del full_name del owner que creó al employee. Texto congelado, sin join.',
          },
          {
            name: 'created_by_id',
            type: 'bigint',
            isNullable: true,
            comment:
              'ID del owner creador. Sin FK formal (informacional). Ver JSDoc de la migración.',
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
        checks: [
          {
            // Invariante: habilitar login requiere credenciales completas.
            name: 'chk_employees_login_requires_credentials',
            expression: `
              (login_enabled = false)
              OR (
                username IS NOT NULL
                AND password IS NOT NULL
                AND length(btrim(username)) > 0
              )
            `,
          },
          {
            // username nunca puede ser cadena en blanco (NULL sí permitido).
            name: 'chk_employees_username_not_empty',
            expression: 'username IS NULL OR length(btrim(username)) > 0',
          },
          {
            // name siempre presente y no en blanco.
            name: 'chk_employees_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
        ],
      }),
      true,
    );

    // 3. FK a companies. ON DELETE RESTRICT: no se borra company con employees.
    await queryRunner.createForeignKey(
      'employees',
      new TableForeignKey({
        name: 'fk_employees_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. UNIQUE parcial en username — login lookup global.
    //
    //    Justificación: `POST /auth/user` busca employee por username (sin
    //    conocer la company). UNIQUE garantiza tanto el lookup O(log n) como
    //    la invariante "un username = una identidad". PARCIAL (WHERE username
    //    IS NOT NULL) permite múltiples employees con username NULL — caso
    //    válido cuando el employee aún no tiene login habilitado.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_employees_username_unique
      ON employees (username)
      WHERE username IS NOT NULL
    `);

    // 5. Índice en company_id (FK).
    //
    //    Justificación: toda query autenticada filtra por company_id.
    //    Necesario también para que el RESTRICT on delete de companies
    //    no degrade en seq scan.
    await queryRunner.createIndex(
      'employees',
      new TableIndex({
        name: 'idx_employees_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 6. Índice compuesto parcial (company_id) WHERE is_archived = false.
    //
    //    Justificación: el endpoint `GET /employees` lista employees activos
    //    de la company autenticada (filtro `is_archived = false`). Índice
    //    parcial reduce tamaño al excluir registros archivados (que sólo se
    //    consultan en reportes ocasionales).
    await queryRunner.query(`
      CREATE INDEX idx_employees_company_active
      ON employees (company_id)
      WHERE is_archived = false
    `);

    // 7. Índice compuesto (company_id, role).
    //
    //    Justificación: filtros administrativos por rol dentro de una company
    //    (ej. listar managers para asignar permisos). Bajo costo de escritura,
    //    cubre futuro endpoint `GET /employees?role=manager`.
    await queryRunner.createIndex(
      'employees',
      new TableIndex({
        name: 'idx_employees_company_role',
        columnNames: ['company_id', 'role'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('employees', 'idx_employees_company_role');
    await queryRunner.query('DROP INDEX IF EXISTS idx_employees_company_active');
    await queryRunner.dropIndex('employees', 'idx_employees_company_id');
    await queryRunner.query('DROP INDEX IF EXISTS idx_employees_username_unique');
    await queryRunner.dropForeignKey('employees', 'fk_employees_company_id');
    await queryRunner.dropTable('employees');
    await queryRunner.query('DROP TYPE IF EXISTS employee_role');
  }
}
