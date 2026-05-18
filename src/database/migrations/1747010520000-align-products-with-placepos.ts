import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alineación del schema de `products` con el esquema canónico de PlacePos
 * (Electron). El cliente envía `stock`, `is_purchasable`, `category_id` (y
 * eventualmente `hash`) al crear / actualizar un producto en modo cloud y
 * espera recibirlos de vuelta en los endpoints `GET /inventory` y
 * `GET /inventory/:id`. Hasta ahora esos campos no existían en pos_api y el
 * pipeline de validación los rechazaba con `should not exist`.
 *
 * Regla maestra: pos_api se adapta a lo que envía PlacePos, nunca al revés.
 *
 * --------------------------------------------------------------------------
 * Columnas añadidas a `products`
 * --------------------------------------------------------------------------
 *
 *   - `stock numeric(15,4) NOT NULL DEFAULT 0`
 *     Stock unitario (espejo Electron). Persistido en la unidad mínima
 *     vendible — `stock_display` se deriva contra `packaging.value` en la
 *     capa de respuesta. Check `stock >= 0` (los ajustes de inventario que
 *     bajen stock deben validarse en la lógica de venta/compra, no aquí).
 *
 *   - `is_purchasable boolean NOT NULL DEFAULT false`
 *     Marca productos creados desde el módulo de compras (quick-create) o
 *     items con presentaciones (parent) que no se venden directamente en el
 *     POS pero sí se compran. Default `false` para no romper backfill —
 *     productos existentes nacen como NO comprables.
 *
 *   - `hash text NULL`
 *     Huella generada en el cliente (PlacePos calcula hash localmente). En
 *     pos_api lo persistimos passthrough — NO se recalcula del lado del
 *     servidor para no divergir del valor del cliente. NULLABLE porque
 *     payloads viejos pueden no enviarlo.
 *
 * --------------------------------------------------------------------------
 * `category_id` — no se añade aquí
 * --------------------------------------------------------------------------
 *
 * La columna y la FK ya las introduce la migración Fase 2A
 * (`1747009740000-create-categories-table.ts`). El índice
 * `idx_products_category_id` también ya existe. Esta migración solo cubre
 * los 3 campos faltantes.
 */
export class AlignProductsWithPlacepos1747010520000 implements MigrationInterface {
  name = 'AlignProductsWithPlacepos1747010520000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. `stock` — numeric(15,4) NOT NULL DEFAULT 0. Backfill implícito con
    //    el DEFAULT 0 para registros existentes.
    await queryRunner.query(`
      ALTER TABLE products
      ADD COLUMN stock numeric(15, 4) NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE products
      ADD CONSTRAINT chk_products_stock_non_negative CHECK (stock >= 0)
    `);

    // 2. `is_purchasable` — boolean NOT NULL DEFAULT false.
    await queryRunner.query(`
      ALTER TABLE products
      ADD COLUMN is_purchasable boolean NOT NULL DEFAULT false
    `);

    // 3. `hash` — text NULL. Sin índice (es de tipo informativo desde el
    //    cliente, no es lookup). Si en el futuro se usa para dedup, se
    //    añade un UNIQUE parcial en otra migración.
    await queryRunner.query(`
      ALTER TABLE products
      ADD COLUMN hash text NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Orden inverso. Los DROP COLUMN son destructivos (pierdes el dato);
    // documentado en el header.
    await queryRunner.query('ALTER TABLE products DROP COLUMN IF EXISTS hash');
    await queryRunner.query('ALTER TABLE products DROP COLUMN IF EXISTS is_purchasable');
    await queryRunner.query(
      'ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_stock_non_negative',
    );
    await queryRunner.query('ALTER TABLE products DROP COLUMN IF EXISTS stock');
  }
}
