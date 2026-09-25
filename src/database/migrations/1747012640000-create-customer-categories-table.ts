import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Crea la tabla `customer_categories` + añade `customers.category_id`.
 *
 * Contexto del dominio:
 *
 *   Categorías ESPECIALES de clientes (p. ej. "Cliente Redes Sociales",
 *   "Clientes Pueblos"). Capacidad cloud-only — PlacePos local no la usa. Cada
 *   cliente puede pertenecer (opcionalmente) a una categoría per-tenant. El
 *   listado de clientes permite filtrar por ella.
 *
 * --------------------------------------------------------------------------
 * Auditoría (diferencia con `categories` de producto)
 * --------------------------------------------------------------------------
 *
 *   Guarda `created_by` (snapshot textual del actor) y `created_by_id`, igual
 *   que `customers`. Las categorías de producto no auditan; las de cliente sí,
 *   por requisito del negocio.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   - `company_id bigint NOT NULL` + FK a companies (RESTRICT) + índice.
 *   - UNIQUE per-company sobre `lower(btrim(name))` PARCIAL donde
 *     `is_archived = false`. Reúsa el nombre tras archivar.
 *
 * --------------------------------------------------------------------------
 * `customers.category_id` (extensión del schema de customers)
 * --------------------------------------------------------------------------
 *
 *   `bigint NULL` con FK `ON DELETE SET NULL` (borrar físicamente la categoría
 *   desliga al cliente sin borrarlo; el archive es soft y deja la asociación
 *   intacta). Todos los clientes existentes quedan con `category_id = NULL`
 *   (sin backfill — el campo es opcional).
 */
export class CreateCustomerCategoriesTable1747012640000 implements MigrationInterface {
  name = 'CreateCustomerCategoriesTable1747012640000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tabla customer_categories.
    await queryRunner.createTable(
      new Table({
        name: 'customer_categories',
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
              'Tenant al que pertenece la categoría. Asignado desde req.user.company_id; nunca aceptado del payload.',
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment: 'Soft-delete. Archivar libera el nombre para reuso.',
          },
          {
            name: 'created_by',
            type: 'text',
            isNullable: true,
            comment: 'Snapshot del full_name del actor que creó la categoría.',
          },
          {
            name: 'created_by_id',
            type: 'bigint',
            isNullable: true,
            comment: 'ID del actor creador. Sin FK formal — campo informacional.',
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
            name: 'chk_customer_categories_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
        ],
      }),
      true,
    );

    // 2. FK a companies (RESTRICT — no borrar company con categorías).
    await queryRunner.createForeignKey(
      'customer_categories',
      new TableForeignKey({
        name: 'fk_customer_categories_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 3. Índice por company_id (FK + filtros).
    await queryRunner.createIndex(
      'customer_categories',
      new TableIndex({
        name: 'idx_customer_categories_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 4. UNIQUE parcial per-company sobre `lower(btrim(name))` para activas.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_customer_categories_company_name_unique
      ON customer_categories (company_id, lower(btrim(name)))
      WHERE is_archived = false
    `);

    // 5. Añadir `category_id` a `customers` (FK opcional).
    await queryRunner.query(`
      ALTER TABLE customers
      ADD COLUMN category_id bigint NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN customers.category_id IS
      'FK opcional a customer_categories. Categoría ESPECIAL del cliente. ON DELETE SET NULL.'
    `);

    await queryRunner.createForeignKey(
      'customers',
      new TableForeignKey({
        name: 'fk_customers_category_id',
        columnNames: ['category_id'],
        referencedTableName: 'customer_categories',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.query(`
      CREATE INDEX idx_customers_category_id
      ON customers (category_id)
      WHERE category_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_customers_category_id');
    await queryRunner.dropForeignKey('customers', 'fk_customers_category_id');
    await queryRunner.query('ALTER TABLE customers DROP COLUMN IF EXISTS category_id');

    await queryRunner.query('DROP INDEX IF EXISTS idx_customer_categories_company_name_unique');
    await queryRunner.dropIndex('customer_categories', 'idx_customer_categories_company_id');
    await queryRunner.dropForeignKey('customer_categories', 'fk_customer_categories_company_id');
    await queryRunner.dropTable('customer_categories');
  }
}
