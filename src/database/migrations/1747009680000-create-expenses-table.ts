import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 9 — Crea la tabla `expenses` (gastos administrativos).
 *
 * Espeja `placepos/src/main/database/entities/Expense.ts` con extensión
 * multi-tenant (`company_id` denormalizado, FK e índice).
 *
 * --------------------------------------------------------------------------
 * Decisiones de modelado
 * --------------------------------------------------------------------------
 *
 *   - `source_type` text + `source_id` bigint (mismos nombres que PlacePos).
 *     Validado por CHECK constraint para que solo acepte
 *     `'bank' | 'wallet' | 'cash_register'`. Sin FK formal — espejo PlacePos:
 *     el snapshot de la fuente queda en `source_name` para preservar el dato
 *     aunque la cuenta sea archivada después.
 *
 *   - `is_archived` boolean — convención PlacePos para soft-delete de
 *     `expenses` (igual que en bancos, billeteras, proveedores, empaques).
 *     **No usar `is_deleted` aquí** para mantener paridad byte-por-byte.
 *
 *   - `description` NOT NULL — PlacePos no permite gastos sin descripción.
 *
 *   - `amount numeric(15,2) > 0` — Money rule CLAUDE.md §2.5.
 *
 *   - `category` text nullable — PlacePos lo guarda como string libre
 *     (SUPPLIES, RENT, UTILITIES, SALARY, OTHER) sin enum nativo. Mantenemos
 *     `text` para no romper si en el futuro PlacePos agrega categorías.
 *     Indexamos `(company_id, category)` para los filtros del dashboard.
 *
 *   - `expense_date timestamptz` — fecha contable del gasto, distinta de
 *     `created_at` (el frontend puede registrar gastos retroactivos).
 *
 *   - `notes text nullable` — observación libre adicional.
 *
 * --------------------------------------------------------------------------
 * Side effects en mutaciones (no enforced en DB; lo orquesta la action)
 * --------------------------------------------------------------------------
 *
 *   - INSERT expense → debita el balance de `source_type/source_id` y
 *     registra `FinancialMovement(EXPENSE, EXPENSE)` (o
 *     `CashRegisterLog(CASH_OUT)` si fuente es caja).
 *
 *   - SOFT-DELETE (is_archived=true) → revierte el balance e inserta
 *     `FinancialMovement(INCOME, ADJUSTMENT)` (concept reversal). Solo
 *     permitido si la cuenta origen sigue activa y el balance lo soporta.
 *
 *   - PUT solo edita metadata (description, category, notes). Cambios de
 *     amount/source_type/source_id NO se permiten — exigen reversión + nuevo
 *     gasto (paridad con la semántica de PlacePos `/expenses/:id/void`).
 *
 * --------------------------------------------------------------------------
 * Índices
 * --------------------------------------------------------------------------
 *
 *   a) `(company_id, expense_date DESC) WHERE is_archived = false` — feed
 *      principal del módulo (lista paginable filtrada por rango de fechas).
 *
 *   b) `(company_id, category)` — agrupaciones por categoría (dashboard +
 *      filtros del listado).
 *
 *   c) `(company_id, source_type, source_id)` — auditoría inversa: "todos los
 *      gastos pagados desde este banco/wallet".
 */
export class CreateExpensesTable1747009680000 implements MigrationInterface {
  name = 'CreateExpensesTable1747009680000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'expenses',
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
              'Tenant al que pertenece el gasto. Asignado por el service desde req.user.company_id.',
          },
          {
            name: 'description',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'category',
            type: 'text',
            isNullable: true,
            comment:
              'Categoría libre (SUPPLIES, RENT, UTILITIES, SALARY, OTHER, ...). Espejo del campo texto de PlacePos.',
          },
          {
            name: 'source_type',
            type: 'text',
            isNullable: false,
            comment: `'bank' | 'wallet' | 'cash_register'. Validado por CHECK.`,
          },
          {
            name: 'source_id',
            type: 'bigint',
            isNullable: false,
            comment: 'ID de la cuenta de origen. Snapshot — sin FK formal (espejo PlacePos).',
          },
          {
            name: 'source_name',
            type: 'text',
            isNullable: true,
            comment: 'Snapshot del nombre de la fuente al momento del gasto.',
          },
          {
            name: 'expense_date',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
            comment:
              'Fecha contable del gasto. Distinta de created_at — permite registrar gastos retroactivos.',
          },
          {
            name: 'notes',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment:
              'Soft-delete convención PlacePos. true cuando el gasto fue anulado (revierte balance).',
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
          {
            name: 'updated_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
        checks: [
          {
            name: 'chk_expenses_amount_positive',
            expression: 'amount > 0',
          },
          {
            name: 'chk_expenses_description_not_empty',
            expression: 'length(btrim(description)) > 0',
          },
          {
            name: 'chk_expenses_source_type_values',
            expression: `source_type IN ('bank', 'wallet', 'cash_register')`,
          },
        ],
      }),
      true,
    );

    // FK a companies (tenant).
    await queryRunner.createForeignKey(
      'expenses',
      new TableForeignKey({
        name: 'fk_expenses_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índice por tenant (cubre joins / lookups por company_id solo).
    await queryRunner.createIndex(
      'expenses',
      new TableIndex({
        name: 'idx_expenses_company_id',
        columnNames: ['company_id'],
      }),
    );

    // a) Feed principal: (company_id, expense_date DESC) WHERE is_archived = false.
    await queryRunner.query(`
      CREATE INDEX idx_expenses_company_expense_date_active
      ON expenses (company_id, expense_date DESC)
      WHERE is_archived = false
    `);

    // b) Agrupaciones por categoría — `category` puede ser NULL, pero el
    //    índice B-tree multicolumna lo maneja sin problema (Postgres lista
    //    NULLs al final por defecto).
    await queryRunner.createIndex(
      'expenses',
      new TableIndex({
        name: 'idx_expenses_company_category',
        columnNames: ['company_id', 'category'],
      }),
    );

    // c) Auditoría inversa por cuenta origen.
    await queryRunner.createIndex(
      'expenses',
      new TableIndex({
        name: 'idx_expenses_company_source',
        columnNames: ['company_id', 'source_type', 'source_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('expenses', 'idx_expenses_company_source');
    await queryRunner.dropIndex('expenses', 'idx_expenses_company_category');
    await queryRunner.query('DROP INDEX IF EXISTS idx_expenses_company_expense_date_active');
    await queryRunner.dropIndex('expenses', 'idx_expenses_company_id');
    await queryRunner.dropForeignKey('expenses', 'fk_expenses_company_id');
    await queryRunner.dropTable('expenses');
  }
}
