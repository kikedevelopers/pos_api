import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex, TableUnique } from 'typeorm';

/**
 * Ola 2B — Crea las tablas `fixed_expenses` y `fixed_expense_periods` (gastos
 * recurrentes).
 *
 * Espeja las migraciones PlacePos `1789300000000-AddFixedExpenses.ts` y
 * `1789400000000-AddFixedExpensePeriods.ts` con extensión multi-tenant:
 * ambas tablas llevan `company_id bigint NOT NULL` con FK a `companies` e
 * índice.
 *
 * --------------------------------------------------------------------------
 * Decisiones de modelado vs. PlacePos
 * --------------------------------------------------------------------------
 *
 *   - `id` cambia de `SERIAL` (PlacePos) a `bigserial`. Consistencia con el
 *     resto de tablas del API cloud (todas usan `bigserial`).
 *
 *   - `created_by_id` cambia de `integer` (PlacePos) a `bigint` (este API).
 *     Coincide con `users.id` que es bigint.
 *
 *   - `paid_by_id` igual: `integer` → `bigint`.
 *
 *   - `alert_id` igual: `integer` → `bigint`. FK a `app_alerts.id` (que es
 *     bigint en este API).
 *
 *   - **`company_id` denormalizado en `fixed_expense_periods`**: aunque el
 *     parent ya lo tiene, lo replicamos para soportar listados directos por
 *     tenant sin JOIN. Detalle en el JSDoc de la entidad.
 *
 * --------------------------------------------------------------------------
 * Constraints
 * --------------------------------------------------------------------------
 *
 *   - `fixed_expenses`:
 *       * CHECK period_unit IN ('hour','day','week','month')
 *       * CHECK period_quantity > 0
 *       * CHECK amount >= 0
 *       * FK company_id → companies (RESTRICT)
 *
 *   - `fixed_expense_periods`:
 *       * UNIQUE (fixed_expense_id, period_number) — idempotencia del sync
 *       * CHECK status IN ('PENDING','PAID')
 *       * CHECK period_number > 0
 *       * CHECK amount >= 0
 *       * FK fixed_expense_id → fixed_expenses (CASCADE)
 *       * FK alert_id → app_alerts (SET NULL)
 *       * FK company_id → companies (RESTRICT)
 *
 * --------------------------------------------------------------------------
 * Índices
 * --------------------------------------------------------------------------
 *
 *   a) `fixed_expenses(company_id, name) WHERE is_archived=false` — listado
 *       principal activo.
 *
 *   b) `fixed_expense_periods(fixed_expense_id, status)` — patrón típico
 *       "cortes pendientes de este gasto".
 *
 *   c) `fixed_expense_periods(company_id, status, due_at DESC)` — feed
 *       cross-gasto del dashboard ("qué debo esta semana").
 */
export class CreateFixedExpensesTables1747010700000 implements MigrationInterface {
  name = 'CreateFixedExpensesTables1747010700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ----------------------------------------------------------------------
    // fixed_expenses
    // ----------------------------------------------------------------------
    await queryRunner.createTable(
      new Table({
        name: 'fixed_expenses',
        columns: [
          { name: 'id', type: 'bigserial', isPrimary: true },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Tenant del gasto fijo. Asignado por el service desde el JWT.',
          },
          { name: 'name', type: 'text', isNullable: false },
          { name: 'description', type: 'text', isNullable: true },
          {
            name: 'amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'period_unit',
            type: 'text',
            isNullable: false,
            comment: `'hour' | 'day' | 'week' | 'month'. Validado por CHECK.`,
          },
          { name: 'period_quantity', type: 'integer', isNullable: false },
          { name: 'start_date', type: 'timestamptz', isNullable: false },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
          },
          { name: 'created_by', type: 'text', isNullable: false },
          { name: 'created_by_id', type: 'bigint', isNullable: true },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', isNullable: false, default: 'now()' },
        ],
        checks: [
          {
            name: 'chk_fixed_expenses_period_unit',
            expression: `period_unit IN ('hour','day','week','month')`,
          },
          {
            name: 'chk_fixed_expenses_period_quantity_positive',
            expression: 'period_quantity > 0',
          },
          {
            name: 'chk_fixed_expenses_amount_nonneg',
            expression: 'amount >= 0',
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'fixed_expenses',
      new TableForeignKey({
        name: 'fk_fixed_expenses_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'fixed_expenses',
      new TableIndex({
        name: 'idx_fixed_expenses_company_id',
        columnNames: ['company_id'],
      }),
    );

    // Listado principal activo: (company_id, name) WHERE is_archived=false.
    await queryRunner.query(`
      CREATE INDEX idx_fixed_expenses_company_active_name
      ON fixed_expenses (company_id, name)
      WHERE is_archived = false
    `);

    // ----------------------------------------------------------------------
    // fixed_expense_periods
    // ----------------------------------------------------------------------
    await queryRunner.createTable(
      new Table({
        name: 'fixed_expense_periods',
        columns: [
          { name: 'id', type: 'bigserial', isPrimary: true },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'Tenant del corte. Denormalizado (también vive en el FixedExpense padre) para listados directos.',
          },
          { name: 'fixed_expense_id', type: 'bigint', isNullable: false },
          {
            name: 'period_number',
            type: 'integer',
            isNullable: false,
            comment: 'Número secuencial 1..N del corte (n = floor(elapsed / period_hours)).',
          },
          {
            name: 'due_at',
            type: 'timestamptz',
            isNullable: false,
            comment: 'start_date + n * period.',
          },
          {
            name: 'amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'status',
            type: 'text',
            isNullable: false,
            default: `'PENDING'`,
          },
          { name: 'alert_id', type: 'bigint', isNullable: true },
          { name: 'paid_at', type: 'timestamptz', isNullable: true },
          { name: 'paid_by_id', type: 'bigint', isNullable: true },
          { name: 'created_at', type: 'timestamptz', isNullable: false, default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', isNullable: false, default: 'now()' },
        ],
        checks: [
          {
            name: 'chk_fixed_expense_periods_status',
            expression: `status IN ('PENDING','PAID')`,
          },
          {
            name: 'chk_fixed_expense_periods_period_number_positive',
            expression: 'period_number > 0',
          },
          {
            name: 'chk_fixed_expense_periods_amount_nonneg',
            expression: 'amount >= 0',
          },
        ],
      }),
      true,
    );

    await queryRunner.createUniqueConstraint(
      'fixed_expense_periods',
      new TableUnique({
        name: 'UQ_fixed_expense_periods_expense_number',
        columnNames: ['fixed_expense_id', 'period_number'],
      }),
    );

    await queryRunner.createForeignKey(
      'fixed_expense_periods',
      new TableForeignKey({
        name: 'fk_fixed_expense_periods_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'fixed_expense_periods',
      new TableForeignKey({
        name: 'fk_fixed_expense_periods_expense',
        columnNames: ['fixed_expense_id'],
        referencedTableName: 'fixed_expenses',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'fixed_expense_periods',
      new TableForeignKey({
        name: 'fk_fixed_expense_periods_alert',
        columnNames: ['alert_id'],
        referencedTableName: 'app_alerts',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'fixed_expense_periods',
      new TableIndex({
        name: 'idx_fixed_expense_periods_company_id',
        columnNames: ['company_id'],
      }),
    );

    await queryRunner.createIndex(
      'fixed_expense_periods',
      new TableIndex({
        name: 'idx_fixed_expense_periods_pending',
        columnNames: ['fixed_expense_id', 'status'],
      }),
    );

    // Feed dashboard: "qué le debo esta semana", ordenado por vencimiento.
    await queryRunner.query(`
      CREATE INDEX idx_fixed_expense_periods_company_status_due
      ON fixed_expense_periods (company_id, status, due_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_fixed_expense_periods_company_status_due`);
    await queryRunner.dropIndex('fixed_expense_periods', 'idx_fixed_expense_periods_pending');
    await queryRunner.dropIndex('fixed_expense_periods', 'idx_fixed_expense_periods_company_id');
    await queryRunner.dropForeignKey('fixed_expense_periods', 'fk_fixed_expense_periods_alert');
    await queryRunner.dropForeignKey('fixed_expense_periods', 'fk_fixed_expense_periods_expense');
    await queryRunner.dropForeignKey(
      'fixed_expense_periods',
      'fk_fixed_expense_periods_company_id',
    );
    await queryRunner.dropUniqueConstraint(
      'fixed_expense_periods',
      'UQ_fixed_expense_periods_expense_number',
    );
    await queryRunner.dropTable('fixed_expense_periods');

    await queryRunner.query(`DROP INDEX IF EXISTS idx_fixed_expenses_company_active_name`);
    await queryRunner.dropIndex('fixed_expenses', 'idx_fixed_expenses_company_id');
    await queryRunner.dropForeignKey('fixed_expenses', 'fk_fixed_expenses_company_id');
    await queryRunner.dropTable('fixed_expenses');
  }
}
