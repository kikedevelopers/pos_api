import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 2A — Crea la tabla `categories` + añade `category_id` a `products`.
 *
 * Contexto del dominio:
 *
 *   PlacePos modela `Category` como agrupador del catálogo. Cada producto
 *   puede pertenecer (opcionalmente) a una categoría per-tenant. El endpoint
 *   `GET /categories/:id/products` devuelve los productos no archivados que
 *   pertenecen a la categoría.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   - `company_id bigint NOT NULL` + FK a companies + índice.
 *   - UNIQUE per-company sobre `lower(btrim(name))` PARCIAL donde
 *     `is_archived = false`. Reúsa el nombre tras archivar.
 *
 * --------------------------------------------------------------------------
 * `products.category_id` (extensión del schema de products)
 * --------------------------------------------------------------------------
 *
 *   La migración 1747008240000-create-products-table.ts no incluyó
 *   `category_id`. Lo añadimos aquí como `bigint NULL` con FK ON DELETE SET
 *   NULL (archivar la categoría desliga al producto sin borrarlo). El down
 *   revierte la columna antes de droppear `categories`.
 */
export class CreateCategoriesTable1747009740000 implements MigrationInterface {
  name = 'CreateCategoriesTable1747009740000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tabla categories.
    await queryRunner.createTable(
      new Table({
        name: 'categories',
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
            comment: 'Soft-delete convención PlacePos.',
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
            name: 'chk_categories_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
        ],
      }),
      true,
    );

    // 2. FK a companies (RESTRICT — no borrar company con categorías).
    await queryRunner.createForeignKey(
      'categories',
      new TableForeignKey({
        name: 'fk_categories_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 3. Índice por company_id (FK + filtros).
    await queryRunner.createIndex(
      'categories',
      new TableIndex({
        name: 'idx_categories_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 4. UNIQUE parcial per-company sobre `lower(btrim(name))` para activas.
    //    Archivar libera el nombre para reuso (espejo PlacePos).
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_categories_company_name_unique
      ON categories (company_id, lower(btrim(name)))
      WHERE is_archived = false
    `);

    // 5. Añadir `category_id` a `products` (FK opcional).
    await queryRunner.query(`
      ALTER TABLE products
      ADD COLUMN category_id bigint NULL
    `);

    await queryRunner.createForeignKey(
      'products',
      new TableForeignKey({
        name: 'fk_products_category_id',
        columnNames: ['category_id'],
        referencedTableName: 'categories',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.query(`
      CREATE INDEX idx_products_category_id
      ON products (category_id)
      WHERE category_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_products_category_id');
    await queryRunner.dropForeignKey('products', 'fk_products_category_id');
    await queryRunner.query('ALTER TABLE products DROP COLUMN IF EXISTS category_id');

    await queryRunner.query('DROP INDEX IF EXISTS idx_categories_company_name_unique');
    await queryRunner.dropIndex('categories', 'idx_categories_company_id');
    await queryRunner.dropForeignKey('categories', 'fk_categories_company_id');
    await queryRunner.dropTable('categories');
  }
}
