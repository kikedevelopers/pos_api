import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 6 — Crea la tabla `sale_invoice_lines`.
 *
 * Cada línea de una venta. Espejo de
 * `placepos/src/main/database/entities/SaleInvoiceLine.ts`:
 *
 *   - Vínculo CASCADE con `sale_invoices.id`: si la venta se borra
 *     físicamente, las líneas también. En práctica las ventas se
 *     soft-deletean (`is_deleted = true`).
 *
 *   - FK RESTRICT a `products.id` (snapshot histórico, no se permite
 *     borrar un producto con histórico de ventas).
 *
 *   - FK RESTRICT a `packagings.id` y `product_prices.id` (nullable —
 *     la línea puede no usar empaque o no referenciar nivel de precio).
 *
 *   - `company_id` denormalizado (espejo PlacePos) — coincide con
 *     `sale_invoice.company_id`, impuesto por el service.
 *
 * --------------------------------------------------------------------------
 * Precisión
 * --------------------------------------------------------------------------
 *
 *   Cantidades `numeric(15,4)`. Montos `numeric(15,2)`. CLAUDE.md §2.5.
 *
 *   `subtotal`, `iva_amount`, `total`, `profit` calculados en el service
 *   con Big.js antes del INSERT. NUNCA con `number` puro.
 */
export class CreateSaleInvoiceLinesTable1747009320000 implements MigrationInterface {
  name = 'CreateSaleInvoiceLinesTable1747009320000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'sale_invoice_lines',
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
              'Denormalizado. Coincide con sale_invoice.company_id; impuesto por el service.',
          },
          {
            name: 'sale_invoice_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'product_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'packaging_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'product_price_id',
            type: 'bigint',
            isNullable: true,
            comment: 'Nivel de precio aplicado (ej. Detal / Mayor). NULL si fue precio libre.',
          },
          {
            name: 'description',
            type: 'text',
            isNullable: false,
            comment: 'Snapshot del nombre del producto al momento de la venta.',
          },
          {
            name: 'quantity',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
          },
          {
            name: 'unit_price',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Precio unitario al momento de la venta (snapshot).',
          },
          {
            name: 'unit_cost',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Costo unitario al momento de la venta (para cálculo de profit).',
          },
          {
            name: 'subtotal',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'unit_price * quantity (base imponible).',
          },
          {
            name: 'iva_percentage',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
            comment: 'Porcentaje IVA aplicado a esta línea (snapshot del product_price).',
          },
          {
            name: 'iva_amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'subtotal * iva_percentage / 100.',
          },
          {
            name: 'total',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'subtotal + iva_amount.',
          },
          {
            name: 'profit',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: '(unit_price - unit_cost) * quantity.',
          },
          {
            name: 'margin',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
            comment: 'Porcentaje (profit / total) * 100 (snapshot).',
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
            name: 'chk_sale_invoice_lines_quantity_positive',
            expression: 'quantity > 0',
          },
          {
            name: 'chk_sale_invoice_lines_unit_price_non_negative',
            expression: 'unit_price >= 0',
          },
          {
            name: 'chk_sale_invoice_lines_unit_cost_non_negative',
            expression: 'unit_cost >= 0',
          },
          {
            name: 'chk_sale_invoice_lines_subtotal_non_negative',
            expression: 'subtotal >= 0',
          },
          {
            name: 'chk_sale_invoice_lines_iva_percentage_valid',
            expression: 'iva_percentage >= 0 AND iva_percentage <= 100',
          },
          {
            name: 'chk_sale_invoice_lines_iva_amount_non_negative',
            expression: 'iva_amount >= 0',
          },
          {
            name: 'chk_sale_invoice_lines_total_non_negative',
            expression: 'total >= 0',
          },
          {
            name: 'chk_sale_invoice_lines_description_not_empty',
            expression: 'length(btrim(description)) > 0',
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'sale_invoice_lines',
      new TableForeignKey({
        name: 'fk_sale_invoice_lines_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a sale_invoices. CASCADE.
    await queryRunner.createForeignKey(
      'sale_invoice_lines',
      new TableForeignKey({
        name: 'fk_sale_invoice_lines_sale_invoice_id',
        columnNames: ['sale_invoice_id'],
        referencedTableName: 'sale_invoices',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a products. RESTRICT.
    await queryRunner.createForeignKey(
      'sale_invoice_lines',
      new TableForeignKey({
        name: 'fk_sale_invoice_lines_product_id',
        columnNames: ['product_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a packagings (nullable). RESTRICT.
    await queryRunner.createForeignKey(
      'sale_invoice_lines',
      new TableForeignKey({
        name: 'fk_sale_invoice_lines_packaging_id',
        columnNames: ['packaging_id'],
        referencedTableName: 'packagings',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a product_prices (nullable). RESTRICT.
    await queryRunner.createForeignKey(
      'sale_invoice_lines',
      new TableForeignKey({
        name: 'fk_sale_invoice_lines_product_price_id',
        columnNames: ['product_price_id'],
        referencedTableName: 'product_prices',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    // a) FK sale_invoice_id — listar líneas de una venta.
    await queryRunner.createIndex(
      'sale_invoice_lines',
      new TableIndex({
        name: 'idx_sale_invoice_lines_sale_invoice_id',
        columnNames: ['sale_invoice_id'],
      }),
    );

    // b) (company_id, product_id, created_at DESC) — histórico de ventas
    //    por producto (analytics / top products).
    await queryRunner.query(`
      CREATE INDEX idx_sale_invoice_lines_company_product_created
      ON sale_invoice_lines (company_id, product_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_invoice_lines_company_product_created');
    await queryRunner.dropIndex('sale_invoice_lines', 'idx_sale_invoice_lines_sale_invoice_id');
    await queryRunner.dropForeignKey(
      'sale_invoice_lines',
      'fk_sale_invoice_lines_product_price_id',
    );
    await queryRunner.dropForeignKey('sale_invoice_lines', 'fk_sale_invoice_lines_packaging_id');
    await queryRunner.dropForeignKey('sale_invoice_lines', 'fk_sale_invoice_lines_product_id');
    await queryRunner.dropForeignKey('sale_invoice_lines', 'fk_sale_invoice_lines_sale_invoice_id');
    await queryRunner.dropForeignKey('sale_invoice_lines', 'fk_sale_invoice_lines_company_id');
    await queryRunner.dropTable('sale_invoice_lines');
  }
}
