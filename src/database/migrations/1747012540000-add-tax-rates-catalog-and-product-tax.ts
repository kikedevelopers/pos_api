import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Facturación Electrónica — modelo fiscal de IVA (parte 1: catálogo + producto).
 *
 * 1. Catálogo GLOBAL `tax_rates` con las tarifas de IVA de Colombia (19%, 5%,
 *    0% y Exento). Nacional y fijo → sin `company_id`, sembrado aquí una vez y
 *    de solo lectura desde la app.
 * 2. `products.tax_rate_id` → la tarifa que aplica al producto. NULL = sin
 *    definir; la UI lo trata como Exento.
 * 3. `product_prices`: `taxable_base` (base gravable) y `tax_amount` (valor del
 *    IVA). El `sale_price` SIGUE siendo el total (base + IVA) — el valor se
 *    ingresa con IVA incluido y aquí solo se discrimina el desglose. Convive con
 *    la `iva_percentage` ya existente (se mantiene sincronizada con la tarifa).
 *
 * Todo el proceso de FE (armado, firma y envío a la DIAN) lo ejecuta el API
 * externo de Laravel (APIDIAN); esto solo almacena la información fiscal.
 */
export class AddTaxRatesCatalogAndProductTax1747012540000 implements MigrationInterface {
  name = 'AddTaxRatesCatalogAndProductTax1747012540000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- 1. Catálogo global de tarifas de IVA ----
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tax_rates" (
        "id" bigserial PRIMARY KEY,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "rate" numeric(5,2) NOT NULL DEFAULT 0,
        "description" text NULL,
        "sort_order" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_tax_rates_code" UNIQUE ("code"),
        CONSTRAINT "chk_tax_rates_rate_valid" CHECK ("rate" >= 0 AND "rate" <= 100)
      )
    `);

    await queryRunner.query(`
      COMMENT ON TABLE "tax_rates" IS
      'Catálogo GLOBAL (sin company_id) de tarifas de IVA de Colombia. Solo lectura desde la app; sembrado en migración.'
    `);

    // Semilla. Orden: 19% primero (el más común), luego 5%, 0% y Exento. El
    // Exento es el default fiscal más seguro para un producto sin clasificar.
    await queryRunner.query(`
      INSERT INTO "tax_rates" ("code", "name", "rate", "description", "sort_order")
      VALUES
        ('IVA_19', 'IVA 19%', 19, 'Tarifa general. Aplica a la mayoría de bienes y servicios gravados.', 1),
        ('IVA_5',  'IVA 5%',  5,  'Tarifa reducida. Aplica a bienes y servicios específicos (p. ej. algunos alimentos y productos de la canasta).', 2),
        ('IVA_0',  'IVA 0%',  0,  'Bienes y servicios gravados a tarifa cero (exportaciones y algunos productos con derecho a devolución).', 3),
        ('EXEMPT', 'Exento',  0,  'El producto no causa IVA. Úsalo cuando el bien o servicio está excluido/exento del impuesto.', 4)
      ON CONFLICT ("code") DO NOTHING
    `);

    // ---- 2. Referencia de IVA en el producto ----
    await queryRunner.query(`
      ALTER TABLE "products"
      ADD COLUMN IF NOT EXISTS "tax_rate_id" bigint NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "products"."tax_rate_id" IS
      'FK al catálogo tax_rates: tarifa de IVA del producto. NULL = sin definir (la UI lo trata como Exento).'
    `);

    await queryRunner.query(`
      ALTER TABLE "products"
      ADD CONSTRAINT "fk_products_tax_rate"
      FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_products_tax_rate_id" ON "products" ("tax_rate_id")
    `);

    // ---- 3. Desglose de base/IVA por precio ----
    await queryRunner.query(`
      ALTER TABLE "product_prices"
      ADD COLUMN IF NOT EXISTS "taxable_base" numeric(15,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "tax_amount"   numeric(15,2) NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "product_prices"."taxable_base" IS
      'Base gravable del precio (sale_price sin IVA). sale_price = taxable_base + tax_amount.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "product_prices"."tax_amount" IS
      'Valor del IVA contenido en sale_price (precio ingresado con IVA incluido).'
    `);

    // Backfill: sin FE los precios existentes no tienen IVA discriminado, así
    // que toda la venta es base gravable (equivale a Exento). Idempotente.
    await queryRunner.query(`
      UPDATE "product_prices"
      SET "taxable_base" = "sale_price", "tax_amount" = 0
      WHERE "taxable_base" = 0 AND "tax_amount" = 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product_prices"
      DROP COLUMN IF EXISTS "tax_amount",
      DROP COLUMN IF EXISTS "taxable_base"
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_products_tax_rate_id"`);
    await queryRunner.query(`
      ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "fk_products_tax_rate"
    `);
    await queryRunner.query(`
      ALTER TABLE "products" DROP COLUMN IF EXISTS "tax_rate_id"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "tax_rates"`);
  }
}
