import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop del CHECK `chk_products_stock_non_negative` agregado en la migración
 * Fase 4A (`1747010520000-align-products-with-placepos.ts`).
 *
 * Motivación: paridad estricta con PlacePos. PlacePos NO tiene este check —
 * `adjustInventory` permite que el stock quede negativo cuando
 * `strict_inventory_control=false`. La mayoría de comercios prefieren no
 * bloquear nunca la venta y aceptan el stock negativo como auditoría.
 *
 * Cuando `strict_inventory_control=true` (o `overrideStock=false` sin
 * permiso), `adjustInventory` lanza `InsufficientStockError` ANTES de
 * intentar el UPDATE, así que la protección sigue siendo efectiva.
 *
 * El CHECK estaba causando 500 (constraint violation) durante el cobro de
 * pedidos cuyo stock final quedaba en negativo — el helper había
 * decidido permitir la venta pero el INSERT explotaba a nivel DB.
 */
export class DropProductsStockNonNegativeCheck1747010940000 implements MigrationInterface {
  name = 'DropProductsStockNonNegativeCheck1747010940000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      DROP CONSTRAINT IF EXISTS chk_products_stock_non_negative
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-añadir el CHECK puede fallar si la tabla ya tiene filas con
    // stock < 0. El down es best-effort: si hay datos negativos, se debe
    // limpiarlos antes de revertir.
    await queryRunner.query(`
      ALTER TABLE products
      ADD CONSTRAINT chk_products_stock_non_negative CHECK (stock >= 0)
    `);
  }
}
