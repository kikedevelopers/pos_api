import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 3 — Crea la tabla `product_prices`.
 *
 * Contexto del dominio:
 *
 *   Un `Product` tiene 1..N precios (ej. "Detal", "Mayor"). PlacePos persiste
 *   `sale_price`, `profit` y `margin` por precio. El cálculo de `profit` y
 *   `margin` se hace en el servidor usando `calculateProfit` y
 *   `calculateMargin` (Big.js) — el cliente puede enviar valores hint que
 *   el servidor IGNORA si están vacíos.
 *
 * --------------------------------------------------------------------------
 * Divergencias intencionales vs PlacePos local
 * --------------------------------------------------------------------------
 *
 *   1. **Multi-tenancy**: tabla con `company_id NOT NULL` (FK a `companies`).
 *      Esto es **redundante** respecto a la FK `product_id` (porque el
 *      product ya conoce su company), pero permite filtrar por company
 *      sin join — patrón común en columnas denormalizadas. Mantenido por
 *      coherencia con multi-tenant-rules §1.
 *
 *   2. **Campo `name`**: el usuario solicitó este campo (ej. "Detal",
 *      "Mayor"). PlacePos NO lo tiene — distingue precios por orden de
 *      array. Lo añadimos como columna `text NOT NULL DEFAULT ''` para
 *      preservar paridad: el cliente PlacePos que no envíe `name` recibe
 *      `''`. Cuando otros clientes usen la API podrán distinguir niveles
 *      de precio sin romper el contrato.
 *
 *   3. **`iva_percentage`**: solicitado por usuario, no presente en PlacePos
 *      para ventas (PlacePos solo discrimina IVA en compras). Lo añadimos
 *      como `numeric(15,4) DEFAULT 0` — opt-in, default 0 mantiene el
 *      comportamiento PlacePos (precio final).
 *
 *   4. **Renombrado del campo principal**: el usuario pidió `value` como
 *      nombre del campo monetario. PlacePos usa `sale_price`. Para
 *      mantener paridad del contrato HTTP, **persistimos como `sale_price`
 *      (espejo PlacePos)** y exponemos también como `sale_price` en la
 *      respuesta. Si se necesita el alias `value` en el futuro, se añade
 *      sin romper.
 *
 * --------------------------------------------------------------------------
 * Cálculo de profit y margin
 * --------------------------------------------------------------------------
 *
 * `profit = sale_price - cost`  (numeric 15,2)
 * `margin = (profit / sale_price) * 100`  (numeric 15,4, evita división
 *                                          por cero si sale_price = 0)
 *
 * Se calculan con Big.js en `calculateProfit` / `calculateMargin`
 * (`@/common/utils/precision`).
 *
 * --------------------------------------------------------------------------
 * Índices
 * --------------------------------------------------------------------------
 *
 *   - `idx_product_prices_product_id` — para `WHERE product_id = $1` (carga
 *     de prices al normalizar Product).
 *   - `idx_product_prices_company_id` — multi-tenant filter.
 *
 * --------------------------------------------------------------------------
 * ON DELETE CASCADE
 * --------------------------------------------------------------------------
 *
 * Si en el futuro se permite borrado físico de Product (hoy no), los prices
 * se borran en cascada — espejo PlacePos.
 */
export class CreateProductPricesTable1747008300000 implements MigrationInterface {
  name = 'CreateProductPricesTable1747008300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'product_prices',
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
              'Tenant denormalizado para filtros directos sin join a products. Coherencia enforced por el service.',
          },
          {
            name: 'product_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
            default: `''`,
            comment:
              'Nombre del nivel de precio ("Detal", "Mayor"). Default vacío por paridad PlacePos.',
          },
          {
            name: 'sale_price',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Precio de venta. numeric(15,2). Espejo de PlacePos.',
          },
          {
            name: 'profit',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Ganancia unitaria = sale_price - cost. Calculada con Big.js.',
          },
          {
            name: 'margin',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
            comment: 'Margen % = (profit / sale_price) * 100. Calculado con Big.js.',
          },
          {
            name: 'iva_percentage',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
            comment: 'Porcentaje de IVA (opt-in). 0 = precio final sin discriminar.',
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
            name: 'chk_product_prices_sale_price_non_negative',
            expression: 'sale_price >= 0',
          },
          {
            name: 'chk_product_prices_iva_percentage_valid',
            expression: 'iva_percentage >= 0 AND iva_percentage <= 100',
          },
        ],
      }),
      true,
    );

    // FK a products (CASCADE — borrar producto borra prices).
    await queryRunner.createForeignKey(
      'product_prices',
      new TableForeignKey({
        name: 'fk_product_prices_product_id',
        columnNames: ['product_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a companies (RESTRICT).
    await queryRunner.createForeignKey(
      'product_prices',
      new TableForeignKey({
        name: 'fk_product_prices_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índice por product_id — query principal: cargar prices de un product.
    await queryRunner.createIndex(
      'product_prices',
      new TableIndex({
        name: 'idx_product_prices_product_id',
        columnNames: ['product_id'],
      }),
    );

    // Índice por company_id — multi-tenant filter directo.
    await queryRunner.createIndex(
      'product_prices',
      new TableIndex({
        name: 'idx_product_prices_company_id',
        columnNames: ['company_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('product_prices', 'idx_product_prices_company_id');
    await queryRunner.dropIndex('product_prices', 'idx_product_prices_product_id');
    await queryRunner.dropForeignKey('product_prices', 'fk_product_prices_company_id');
    await queryRunner.dropForeignKey('product_prices', 'fk_product_prices_product_id');
    await queryRunner.dropTable('product_prices');
  }
}
