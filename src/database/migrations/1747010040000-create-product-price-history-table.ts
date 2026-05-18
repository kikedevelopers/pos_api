import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 2A — Crea la tabla `product_price_history`.
 *
 * Contexto del dominio:
 *
 *   Cada cambio de `sale_price` (o sus derivados profit/margin) en un
 *   `product_prices` deja un row en `product_price_history`. PlacePos
 *   consume `GET /product-prices/:id/price-history`. Cuando el cambio
 *   proviene de un recalculo automático tras una compra recibida, el row
 *   apunta al `product_cost_history.id` correspondiente para JOIN.
 *
 *   Fase 2A: tabla creada pero **vacía** — el populate llega en Fase 5+.
 */
export class CreateProductPriceHistoryTable1747010040000 implements MigrationInterface {
  name = 'CreateProductPriceHistoryTable1747010040000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'product_price_history',
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
            name: 'product_price_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'product_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Denormalizado para indexar lookups por producto sin join.',
          },
          {
            name: 'cost_history_id',
            type: 'bigint',
            isNullable: true,
            comment: 'Enlace al ProductCostHistory que disparó este cambio (si aplica).',
          },
          {
            name: 'sale_price',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'profit_before',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
          },
          {
            name: 'profit_after',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
          },
          {
            name: 'margin_before',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
          },
          {
            name: 'margin_after',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
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
      'product_price_history',
      new TableForeignKey({
        name: 'fk_pph_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'product_price_history',
      new TableForeignKey({
        name: 'fk_pph_product_price_id',
        columnNames: ['product_price_id'],
        referencedTableName: 'product_prices',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'product_price_history',
      new TableForeignKey({
        name: 'fk_pph_product_id',
        columnNames: ['product_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'product_price_history',
      new TableForeignKey({
        name: 'fk_pph_cost_history_id',
        columnNames: ['cost_history_id'],
        referencedTableName: 'product_cost_history',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    await queryRunner.createIndex(
      'product_price_history',
      new TableIndex({
        name: 'idx_pph_company_id',
        columnNames: ['company_id'],
      }),
    );

    // Caliente: lookup por product_price_id ordenado por fecha desc.
    await queryRunner.createIndex(
      'product_price_history',
      new TableIndex({
        name: 'idx_pph_product_price_created_at',
        columnNames: ['product_price_id', 'created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('product_price_history', 'idx_pph_product_price_created_at');
    await queryRunner.dropIndex('product_price_history', 'idx_pph_company_id');
    await queryRunner.dropForeignKey('product_price_history', 'fk_pph_cost_history_id');
    await queryRunner.dropForeignKey('product_price_history', 'fk_pph_product_id');
    await queryRunner.dropForeignKey('product_price_history', 'fk_pph_product_price_id');
    await queryRunner.dropForeignKey('product_price_history', 'fk_pph_company_id');
    await queryRunner.dropTable('product_price_history');
  }
}
