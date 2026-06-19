import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * FASE 2 (COMPARTIR) — Crea `inventory_shares`.
 *
 * Modela qué productos del negocio PRINCIPAL (source) puede VER y VENDER una
 * SUCURSAL (target). El producto sigue siendo del principal (única fuente de
 * verdad del stock); compartir es SOLO LECTURA/VENTA en la sucursal.
 *
 * --------------------------------------------------------------------------
 * Granularidad
 * --------------------------------------------------------------------------
 *
 *   - `product_id IS NULL`  → comparte TODO el catálogo de `source` con
 *     `target` (share a nivel company). Un producto FUTURO del principal queda
 *     compartido automáticamente.
 *   - `product_id` no-null  → comparte ese producto específico.
 *
 * --------------------------------------------------------------------------
 * Unicidad (idempotencia)
 * --------------------------------------------------------------------------
 *
 *   - `uq_inventory_shares_company_level` UNIQUE(source, target) WHERE
 *     product_id IS NULL — un único share company-level por par.
 *   - `uq_inventory_shares_product_level` UNIQUE(source, target, product_id)
 *     WHERE product_id IS NOT NULL — un único share por (par, producto).
 *
 * Ambos índices parciales permiten coexistir un share company-level con shares
 * product-level para el mismo par (el company-level domina en visibilidad).
 *
 * --------------------------------------------------------------------------
 * FKs
 * --------------------------------------------------------------------------
 *
 *   - source/target → companies (RESTRICT: no borrar company con shares).
 *   - product_id → products ON DELETE CASCADE: si el producto se borra, su
 *     share desaparece (no deja shares colgantes).
 */
export class CreateInventorySharesTable1747011760000 implements MigrationInterface {
  name = 'CreateInventorySharesTable1747011760000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'inventory_shares',
        columns: [
          { name: 'id', type: 'bigserial', isPrimary: true },
          {
            name: 'source_company_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Principal (dueño del producto/stock).',
          },
          {
            name: 'target_company_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Sucursal que puede ver/vender.',
          },
          {
            name: 'product_id',
            type: 'bigint',
            isNullable: true,
            comment: 'NULL = compartir TODO el catálogo del source; no-null = producto específico.',
          },
          { name: 'created_by_id', type: 'bigint', isNullable: true },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'inventory_shares',
      new TableForeignKey({
        name: 'fk_inventory_shares_source_company_id',
        columnNames: ['source_company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );
    await queryRunner.createForeignKey(
      'inventory_shares',
      new TableForeignKey({
        name: 'fk_inventory_shares_target_company_id',
        columnNames: ['target_company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );
    await queryRunner.createForeignKey(
      'inventory_shares',
      new TableForeignKey({
        name: 'fk_inventory_shares_product_id',
        columnNames: ['product_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // Índice por target — lookups de visibilidad de una sucursal ("¿qué me
    // comparten?") y soporte al filtrado en los listados/POS.
    await queryRunner.createIndex(
      'inventory_shares',
      new TableIndex({
        name: 'idx_inventory_shares_target_company_id',
        columnNames: ['target_company_id'],
      }),
    );
    // Índice por (source, target) — lookups del principal ("¿qué comparto con
    // esta sucursal?") y el GET /shares.
    await queryRunner.createIndex(
      'inventory_shares',
      new TableIndex({
        name: 'idx_inventory_shares_source_target',
        columnNames: ['source_company_id', 'target_company_id'],
      }),
    );

    // Índices únicos parciales (idempotencia). TypeORM no expresa `WHERE` en
    // TableIndex de forma portable → SQL crudo.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_inventory_shares_company_level
      ON inventory_shares (source_company_id, target_company_id)
      WHERE product_id IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_inventory_shares_product_level
      ON inventory_shares (source_company_id, target_company_id, product_id)
      WHERE product_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_inventory_shares_product_level`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_inventory_shares_company_level`);
    await queryRunner.dropIndex('inventory_shares', 'idx_inventory_shares_source_target');
    await queryRunner.dropIndex('inventory_shares', 'idx_inventory_shares_target_company_id');
    await queryRunner.dropForeignKey('inventory_shares', 'fk_inventory_shares_product_id');
    await queryRunner.dropForeignKey('inventory_shares', 'fk_inventory_shares_target_company_id');
    await queryRunner.dropForeignKey('inventory_shares', 'fk_inventory_shares_source_company_id');
    await queryRunner.dropTable('inventory_shares');
  }
}
