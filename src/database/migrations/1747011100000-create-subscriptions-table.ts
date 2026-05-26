import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Módulo Suscripciones (cloud-only) — Crea la tabla `subscriptions`.
 *
 * Una suscripción POR EMPRESA: trial de gracia de 10 días desde el registro.
 * Cuando `expires_at < now()` la app se bloquea por completo para todos los
 * usuarios de esa company (lo aplica `SubscriptionGuard` + `LoginAction`).
 *
 * --------------------------------------------------------------------------
 * Decisiones de modelado
 * --------------------------------------------------------------------------
 *
 *   - `company_id` UNIQUE (FK companies ON DELETE CASCADE): una sola fila por
 *     company. Si la company se borra, su suscripción cae con ella.
 *   - `owner_user_id` (FK users ON DELETE CASCADE): trazabilidad del owner que
 *     originó la suscripción. El bloqueo NO depende de él (aplica a toda la
 *     company), solo se preserva el dato.
 *   - `started_at` / `expires_at` timestamptz: ventana de vigencia. El cálculo
 *     `expires_at = started_at + 10 días` lo hace `CreateSubscriptionAction`.
 *
 * --------------------------------------------------------------------------
 * Índices
 * --------------------------------------------------------------------------
 *
 *   a) `(company_id)` UNIQUE — lookup del guard/login por tenant + unicidad.
 *   b) `(expires_at)`        — filtrado por vencimiento (barridos futuros).
 *
 * --------------------------------------------------------------------------
 * BACKFILL (modo GRACIA)
 * --------------------------------------------------------------------------
 *
 * Para cada company existente con un user owner, inserta una suscripción con
 * `started_at = now()` y `expires_at = now() + interval '10 days'`, usando como
 * `owner_user_id` el owner más antiguo de esa company. Así las cuentas previas
 * arrancan con 10 días desde la migración y NO quedan bloqueadas de inmediato.
 * Companies sin owner (caso anómalo) se omiten (INNER JOIN implícito vía
 * subquery NOT NULL).
 */
export class CreateSubscriptionsTable1747011100000 implements MigrationInterface {
  name = 'CreateSubscriptionsTable1747011100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'subscriptions',
        columns: [
          { name: 'id', type: 'bigserial', isPrimary: true },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Tenant dueño de la suscripción. UNIQUE: una fila por company.',
          },
          {
            name: 'owner_user_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Owner que originó la suscripción. Solo trazabilidad.',
          },
          {
            name: 'started_at',
            type: 'timestamptz',
            isNullable: false,
            comment: 'Inicio de la ventana de vigencia (registro del owner).',
          },
          {
            name: 'expires_at',
            type: 'timestamptz',
            isNullable: false,
            comment: 'Vencimiento. Cuando < now() la company queda bloqueada.',
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
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'subscriptions',
      new TableForeignKey({
        name: 'fk_subscriptions_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'subscriptions',
      new TableForeignKey({
        name: 'fk_subscriptions_owner_user_id',
        columnNames: ['owner_user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // UNIQUE en company_id — una sola suscripción por company. Sirve también
    // como índice de lookup del guard/login.
    await queryRunner.createIndex(
      'subscriptions',
      new TableIndex({
        name: 'idx_subscriptions_company_id_unique',
        columnNames: ['company_id'],
        isUnique: true,
      }),
    );

    await queryRunner.createIndex(
      'subscriptions',
      new TableIndex({
        name: 'idx_subscriptions_expires_at',
        columnNames: ['expires_at'],
      }),
    );

    // BACKFILL (modo gracia). Inserta una suscripción por cada company que
    // tenga al menos un user owner. `expires_at = now() + 10 días`. Idempotente
    // frente a re-ejecuciones por el UNIQUE de company_id (ON CONFLICT DO
    // NOTHING) — defensa por si la migración corre dos veces en algún flujo.
    await queryRunner.query(`
      INSERT INTO subscriptions (company_id, owner_user_id, started_at, expires_at)
      SELECT
        c.id,
        (
          SELECT u.id
          FROM users u
          WHERE u.company_id = c.id AND u.type = 'owner'
          ORDER BY u.id
          LIMIT 1
        ) AS owner_user_id,
        now() AS started_at,
        now() + interval '10 days' AS expires_at
      FROM companies c
      WHERE EXISTS (
        SELECT 1 FROM users u WHERE u.company_id = c.id AND u.type = 'owner'
      )
      ON CONFLICT (company_id) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DROP TABLE elimina las filas del backfill, los índices y las FKs.
    await queryRunner.dropTable('subscriptions');
  }
}
