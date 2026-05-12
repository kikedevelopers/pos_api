import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 8 — Crea la tabla `purchase_lines`.
 *
 * Cada línea de una compra. Espejo de
 * `placepos/src/main/database/entities/PurchaseLine.ts`:
 *
 *   - Vínculo CASCADE con `purchases.id`: borrar la compra elimina sus
 *     líneas (la compra raíz se soft-deletea, así que el CASCADE es defensivo
 *     contra DELETE administrativo).
 *
 *   - FK RESTRICT a `products.id` y a `packagings.id` (cuando aplica). No
 *     se permite borrar un producto/empaque con histórico de compras.
 *
 *   - `supplier_id` denormalizado (espejo PlacePos): permite comparar costos
 *     entre proveedores sin tener que joinar `purchases`.
 *
 * --------------------------------------------------------------------------
 * Precisión
 * --------------------------------------------------------------------------
 *
 *   Cantidades `numeric(15,4)`. Montos `numeric(15,2)`. CLAUDE.md §2.5.
 *
 *   Los totales por línea (`subtotal`, `iva_amount`, `total`) se calculan en
 *   el service con Big.js antes del INSERT — nunca con `number` puro.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   `company_id` denormalizado para indexar/filtrar sin join. El service
 *   garantiza que `line.company_id === parent_purchase.company_id` antes del
 *   INSERT.
 */
export class CreatePurchaseLinesTable1747008840000 implements MigrationInterface {
  name = 'CreatePurchaseLinesTable1747008840000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'purchase_lines',
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
            comment: 'Denormalizado. Coincide con purchase.company_id; impuesto por el service.',
          },
          {
            name: 'purchase_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'product_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'supplier_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'Denormalizado para comparar costos entre proveedores sin join contra purchases. Espejo PlacePos.',
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
            comment: 'Snapshot del nombre del producto al momento de la compra.',
          },
          {
            name: 'packaging_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'packaging_name',
            type: 'text',
            isNullable: true,
            comment: 'Snapshot del nombre del empaque al momento de la compra.',
          },
          {
            name: 'packaging_value',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: true,
            comment: 'Unidades base por paquete (snapshot). NULL si no se usó paquete.',
          },
          {
            name: 'packaging_qty',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
            comment: 'Cantidad de paquetes comprados.',
          },
          {
            name: 'unit_qty',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
            comment: 'Cantidad total en unidades base = packaging_qty * packaging_value.',
          },
          {
            name: 'unit_price',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
          },
          {
            name: 'packaging_price',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'iva_rate',
            type: 'numeric',
            precision: 5,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Porcentaje de IVA aplicado a esta línea (0, 5, 19, etc.).',
          },
          {
            name: 'subtotal',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'iva_amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'total',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
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
            name: 'chk_purchase_lines_packaging_qty_positive',
            expression: 'packaging_qty > 0',
          },
          {
            name: 'chk_purchase_lines_packaging_price_non_negative',
            expression: 'packaging_price >= 0',
          },
          {
            name: 'chk_purchase_lines_unit_qty_non_negative',
            expression: 'unit_qty >= 0',
          },
          {
            name: 'chk_purchase_lines_unit_price_non_negative',
            expression: 'unit_price >= 0',
          },
          {
            name: 'chk_purchase_lines_iva_rate_non_negative',
            expression: 'iva_rate >= 0',
          },
          {
            name: 'chk_purchase_lines_subtotal_non_negative',
            expression: 'subtotal >= 0',
          },
          {
            name: 'chk_purchase_lines_iva_amount_non_negative',
            expression: 'iva_amount >= 0',
          },
          {
            name: 'chk_purchase_lines_total_non_negative',
            expression: 'total >= 0',
          },
          {
            name: 'chk_purchase_lines_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
        ],
      }),
      true,
    );

    // FK a companies (denormalización defendida por FK formal).
    await queryRunner.createForeignKey(
      'purchase_lines',
      new TableForeignKey({
        name: 'fk_purchase_lines_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a purchases. CASCADE — eliminar la compra (físicamente) limpia sus líneas.
    await queryRunner.createForeignKey(
      'purchase_lines',
      new TableForeignKey({
        name: 'fk_purchase_lines_purchase_id',
        columnNames: ['purchase_id'],
        referencedTableName: 'purchases',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a products. RESTRICT — no se borra producto con histórico de compras.
    await queryRunner.createForeignKey(
      'purchase_lines',
      new TableForeignKey({
        name: 'fk_purchase_lines_product_id',
        columnNames: ['product_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a packagings (nullable). RESTRICT — preserva integridad histórica.
    await queryRunner.createForeignKey(
      'purchase_lines',
      new TableForeignKey({
        name: 'fk_purchase_lines_packaging_id',
        columnNames: ['packaging_id'],
        referencedTableName: 'packagings',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a suppliers (denormalizado).
    await queryRunner.createForeignKey(
      'purchase_lines',
      new TableForeignKey({
        name: 'fk_purchase_lines_supplier_id',
        columnNames: ['supplier_id'],
        referencedTableName: 'suppliers',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    // a) FK purchase_id — leer líneas de una compra.
    await queryRunner.createIndex(
      'purchase_lines',
      new TableIndex({
        name: 'idx_purchase_lines_purchase_id',
        columnNames: ['purchase_id'],
      }),
    );

    // b) (company_id, product_id, created_at DESC) — histórico de compras
    //    por producto (analytics y comparación de costos en el tiempo).
    await queryRunner.query(`
      CREATE INDEX idx_purchase_lines_company_product_created
      ON purchase_lines (company_id, product_id, created_at DESC)
    `);

    // c) (company_id, supplier_id, product_id) — comparativa producto x
    //    proveedor en reportes de compras.
    await queryRunner.createIndex(
      'purchase_lines',
      new TableIndex({
        name: 'idx_purchase_lines_company_supplier_product',
        columnNames: ['company_id', 'supplier_id', 'product_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('purchase_lines', 'idx_purchase_lines_company_supplier_product');
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchase_lines_company_product_created');
    await queryRunner.dropIndex('purchase_lines', 'idx_purchase_lines_purchase_id');
    await queryRunner.dropForeignKey('purchase_lines', 'fk_purchase_lines_supplier_id');
    await queryRunner.dropForeignKey('purchase_lines', 'fk_purchase_lines_packaging_id');
    await queryRunner.dropForeignKey('purchase_lines', 'fk_purchase_lines_product_id');
    await queryRunner.dropForeignKey('purchase_lines', 'fk_purchase_lines_purchase_id');
    await queryRunner.dropForeignKey('purchase_lines', 'fk_purchase_lines_company_id');
    await queryRunner.dropTable('purchase_lines');
  }
}
