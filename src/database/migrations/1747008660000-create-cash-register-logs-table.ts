import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 5 — Crea el tipo enum `cash_register_log_type` y la tabla
 * `cash_register_logs`.
 *
 * Cada CashRegisterLog representa UN movimiento puntual dentro de un turno
 * de caja: ingreso manual, egreso manual, conteo intermedio, traslado, etc.
 *
 * Espeja `placepos/src/main/database/entities/CashRegisterLog.ts` con
 * adaptaciones multi-tenant:
 *
 *   - `company_id` NOT NULL — denormalizado para queries por company sin
 *     join. Asignado por el service desde `req.user.company_id`.
 *
 *   - FK fuerte a `cash_registers` con `ON DELETE RESTRICT`: nunca borrar
 *     una caja con logs (histórico inalterable).
 *
 *   - `type` enum: `CASH_IN`, `CASH_OUT`, `CASH_TRANSFER_IN`,
 *     `CASH_TRANSFER_OUT`, `COUNT`. Espeja los valores que PlacePos guarda
 *     como `movement_type` en texto libre.
 *
 *   - `direction` text ('IN' | 'OUT') — espejo de PlacePos.
 *
 *   - `affects_balance` flag — espejo de PlacePos. Si `false`, el log se
 *     guarda para auditoría pero NO modifica el balance esperado del turno.
 *     Caso de uso: conteos intermedios sin movimiento.
 */
export class CreateCashRegisterLogsTable1747008660000 implements MigrationInterface {
  name = 'CreateCashRegisterLogsTable1747008660000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum nativo.
    await queryRunner.query(`
      CREATE TYPE cash_register_log_type AS ENUM (
        'CASH_IN',
        'CASH_OUT',
        'CASH_TRANSFER_IN',
        'CASH_TRANSFER_OUT',
        'COUNT'
      )
    `);

    // 2. Tabla.
    await queryRunner.createTable(
      new Table({
        name: 'cash_register_logs',
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
              'Tenant denormalizado. Coincide con cash_register.company_id; verificado por el service.',
          },
          {
            name: 'cash_register_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'type',
            type: 'cash_register_log_type',
            isNullable: false,
            enumName: 'cash_register_log_type',
          },
          {
            name: 'direction',
            type: 'text',
            isNullable: false,
            comment: `'IN' | 'OUT'. Espeja PlacePos. Validado por CHECK constraint.`,
          },
          {
            name: 'amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'affects_balance',
            type: 'boolean',
            isNullable: false,
            default: true,
            comment:
              'Si false, el log es informativo (conteo intermedio) y no se suma/resta del expected_balance.',
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'created_by',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'created_by_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
        checks: [
          {
            name: 'chk_cash_register_logs_direction',
            expression: `direction IN ('IN', 'OUT')`,
          },
          {
            name: 'chk_cash_register_logs_amount_non_negative',
            expression: 'amount >= 0',
          },
        ],
      }),
      true,
    );

    // 3. FK a cash_registers. RESTRICT — preserva auditoría.
    await queryRunner.createForeignKey(
      'cash_register_logs',
      new TableForeignKey({
        name: 'fk_cash_register_logs_cash_register_id',
        columnNames: ['cash_register_id'],
        referencedTableName: 'cash_registers',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. FK a companies. Redundante con la FK de cash_registers pero blinda
    //    la denormalización: imposibilita un log con company_id distinto al
    //    de su caja referenciada (Postgres no valida ese cross-table CHECK;
    //    el service sí, y la FK garantiza al menos coherencia con companies).
    await queryRunner.createForeignKey(
      'cash_register_logs',
      new TableForeignKey({
        name: 'fk_cash_register_logs_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 5. Índices.
    //    a) (cash_register_id) — listar logs de un turno.
    await queryRunner.createIndex(
      'cash_register_logs',
      new TableIndex({
        name: 'idx_cash_register_logs_cash_register_id',
        columnNames: ['cash_register_id'],
      }),
    );

    //    b) (company_id, created_at DESC) — feed cronológico por tenant.
    await queryRunner.query(`
      CREATE INDEX idx_cash_register_logs_company_created
      ON cash_register_logs (company_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_cash_register_logs_company_created');
    await queryRunner.dropIndex('cash_register_logs', 'idx_cash_register_logs_cash_register_id');
    await queryRunner.dropForeignKey('cash_register_logs', 'fk_cash_register_logs_company_id');
    await queryRunner.dropForeignKey(
      'cash_register_logs',
      'fk_cash_register_logs_cash_register_id',
    );
    await queryRunner.dropTable('cash_register_logs');
    await queryRunner.query('DROP TYPE IF EXISTS cash_register_log_type');
  }
}
