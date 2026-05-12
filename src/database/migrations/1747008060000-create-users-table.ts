import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 0 — Crea el tipo enum `user_type` y la tabla `users`.
 *
 * Modelo de roles en Fase 0:
 *
 *   - `superadmin`: usuario global del sistema, NO pertenece a ninguna
 *     company (company_id IS NULL). Asignado manualmente en DB.
 *   - `owner`: dueño de una company. Único rol creado vía
 *     `POST /auth/register`. company_id IS NOT NULL.
 *
 *   Los roles operativos (`manager`, `employee`) NO viven aquí — viven en
 *   la futura tabla `employees` con su propio enum `employee_role`. Esto
 *   responde al CLAUDE.md sección 2.7: User y Employee son dos entidades
 *   distintas. Login resuelve ambas en `POST /auth/user`.
 *
 * Integridad reforzada con CHECK constraint:
 *
 *     (type = 'superadmin' AND company_id IS NULL)
 *  OR (type = 'owner'      AND company_id IS NOT NULL)
 *
 *  Esto previene estados inválidos a nivel físico:
 *    - Un superadmin con company_id (cross-tenant ilegal).
 *    - Un owner huérfano sin company.
 *
 * FK a companies con `ON DELETE RESTRICT`: nunca borramos una company que
 * tenga usuarios. La eliminación de un tenant es una operación deliberada
 * que requiere desasignar/migrar usuarios primero.
 */
export class CreateUsersTable1747008060000 implements MigrationInterface {
  name = 'CreateUsersTable1747008060000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum nativo de Postgres.
    await queryRunner.query(`
      CREATE TYPE user_type AS ENUM ('superadmin', 'owner')
    `);

    // 2. Tabla users.
    await queryRunner.createTable(
      new Table({
        name: 'users',
        columns: [
          {
            name: 'id',
            type: 'bigserial',
            isPrimary: true,
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'lastname',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'email',
            type: 'text',
            isNullable: false,
            comment:
              'Identificador de login. UNIQUE global — el espacio de emails es plano entre tenants.',
          },
          {
            name: 'password',
            type: 'text',
            isNullable: false,
            comment: 'Hash argon2id. El service aplica el hash; la columna acepta cualquier texto.',
          },
          {
            name: 'type',
            type: 'user_type',
            isNullable: false,
            enumName: 'user_type',
          },
          {
            name: 'balance',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: true,
            comment: 'NULL solo para superadmin. owner debe tenerlo (enforce vía CHECK).',
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
            name: 'chk_users_type_company_consistency',
            expression: `
              (type = 'superadmin' AND company_id IS NULL)
              OR (type = 'owner' AND company_id IS NOT NULL)
            `,
          },
          {
            name: 'chk_users_balance_not_null',
            expression: 'balance IS NOT NULL',
          },
          {
            name: 'chk_users_email_not_empty',
            expression: 'length(btrim(email)) > 0',
          },
        ],
      }),
      true,
    );

    // 3. FK a companies. ON DELETE RESTRICT: no se borra company con users.
    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({
        name: 'fk_users_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. Índice UNIQUE en email (login lookup).
    //    Justificación: `POST /auth/user` busca usuario por email. Es la
    //    consulta más caliente de la tabla. UNIQUE garantiza tanto el lookup
    //    O(log n) como la regla de negocio "un email = una cuenta".
    await queryRunner.createIndex(
      'users',
      new TableIndex({
        name: 'idx_users_email_unique',
        columnNames: ['email'],
        isUnique: true,
      }),
    );

    // 5. Índice en company_id (FK).
    //    Justificación: toda query autenticada filtra por company_id. Sin
    //    este índice, RESTRICT on delete de companies haría seq scan en users.
    await queryRunner.createIndex(
      'users',
      new TableIndex({
        name: 'idx_users_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 6. Índice compuesto parcial (company_id, type) WHERE company_id IS NOT NULL.
    //    Justificación: localizar al owner de una company es una consulta
    //    recurrente (perfil, dashboard, alertas dirigidas al dueño). El
    //    índice parcial excluye superadmin (company_id NULL), reduciendo
    //    tamaño y acelerando lookups del tipo:
    //    `WHERE company_id = $1 AND type = 'owner'`.
    await queryRunner.query(`
      CREATE INDEX idx_users_company_id_type
      ON users (company_id, type)
      WHERE company_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_users_company_id_type');
    await queryRunner.dropIndex('users', 'idx_users_company_id');
    await queryRunner.dropIndex('users', 'idx_users_email_unique');
    await queryRunner.dropForeignKey('users', 'fk_users_company_id');
    await queryRunner.dropTable('users');
    await queryRunner.query('DROP TYPE IF EXISTS user_type');
  }
}
