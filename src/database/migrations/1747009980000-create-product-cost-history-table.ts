import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 2A — Crea los tipos enum y la tabla `product_cost_history`.
 *
 * Contexto del dominio:
 *
 *   Cada cambio relevante en el `cost` de un producto deja una entrada
 *   auditable en `product_cost_history`. PlacePos consume el endpoint
 *   `GET /products/:id/cost-history?limit=N` para mostrar la evolución
 *   del costo. Genera entries en:
 *
 *     - `RECEIVE`: al confirmar recepción de una compra (Fase 5+).
 *     - `EDIT`: edición manual del cost desde `PUT /inventory/:id`.
 *     - `ARCHIVE`: al archivar el producto (snapshot final).
 *
 *   `derived_from`:
 *     - `PURCHASE`: el costo proviene del recálculo de una compra.
 *     - `PARENT`: heredado del producto padre (combos).
 *
 *   Fase 2A: la tabla queda registrada pero **vacía** — la inserción se
 *   integra en Fase 5+ cuando exista `purchaseReceiveOperations`. Los
 *   endpoints de read funcionan inmediatamente devolviendo listas vacías.
 */
export class CreateProductCostHistoryTable1747009980000 implements MigrationInterface {
  name = 'CreateProductCostHistoryTable1747009980000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE product_cost_history_event AS ENUM ('RECEIVE', 'EDIT', 'ARCHIVE')
    `);
    await queryRunner.query(`
      CREATE TYPE product_cost_history_source AS ENUM ('PURCHASE', 'PARENT')
    `);

    await queryRunner.createTable(
      new Table({
        name: 'product_cost_history',
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
          },
          {
            name: 'product_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'purchase_id',
            type: 'bigint',
            isNullable: true,
            comment: 'NULL si event_type=EDIT/ARCHIVE manual; NOT NULL si RECEIVE.',
          },
          {
            name: 'event_type',
            type: 'product_cost_history_event',
            isNullable: false,
            enumName: 'product_cost_history_event',
          },
          {
            name: 'derived_from',
            type: 'product_cost_history_source',
            isNullable: false,
            enumName: 'product_cost_history_source',
          },
          {
            name: 'cost_before',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
          },
          {
            name: 'cost_after',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
          },
          {
            name: 'change_pct',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
            comment: '(cost_after - cost_before) / cost_before * 100; 0 si cost_before=0.',
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
      }),
      true,
    );

    // FKs.
    await queryRunner.createForeignKey(
      'product_cost_history',
      new TableForeignKey({
        name: 'fk_pch_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'product_cost_history',
      new TableForeignKey({
        name: 'fk_pch_product_id',
        columnNames: ['product_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'product_cost_history',
      new TableForeignKey({
        name: 'fk_pch_purchase_id',
        columnNames: ['purchase_id'],
        referencedTableName: 'purchases',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    await queryRunner.createIndex(
      'product_cost_history',
      new TableIndex({
        name: 'idx_pch_company_id',
        columnNames: ['company_id'],
      }),
    );

    // Caliente: lookup por producto, ordenado por fecha desc (paginado).
    await queryRunner.createIndex(
      'product_cost_history',
      new TableIndex({
        name: 'idx_pch_product_created_at',
        columnNames: ['product_id', 'created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('product_cost_history', 'idx_pch_product_created_at');
    await queryRunner.dropIndex('product_cost_history', 'idx_pch_company_id');
    await queryRunner.dropForeignKey('product_cost_history', 'fk_pch_purchase_id');
    await queryRunner.dropForeignKey('product_cost_history', 'fk_pch_product_id');
    await queryRunner.dropForeignKey('product_cost_history', 'fk_pch_company_id');
    await queryRunner.dropTable('product_cost_history');
    await queryRunner.query('DROP TYPE IF EXISTS product_cost_history_source');
    await queryRunner.query('DROP TYPE IF EXISTS product_cost_history_event');
  }
}
