import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Importación masiva de productos — Dedupe defensivo + reaseguro de índices
 * únicos per-company sobre `products`.
 *
 * --------------------------------------------------------------------------
 * Contexto
 * --------------------------------------------------------------------------
 *
 * La tabla `products` de pos_api YA define (desde la migración base
 * `1747008240000-create-products-table.ts`) tres índices únicos parciales
 * per-company que cubren exactamente lo que el bulk import necesita:
 *
 *   - `idx_products_company_sku_unique`     → (company_id, sku_code)
 *       WHERE sku_code IS NOT NULL AND is_archived = false
 *   - `idx_products_company_barcode_unique` → (company_id, bar_code)
 *       WHERE bar_code IS NOT NULL AND is_archived = false
 *   - `idx_products_company_name_unique`    → (company_id, lower(btrim(name)))
 *       WHERE is_archived = false
 *
 * Son funcionalmente equivalentes (mejores, incluso: el predicado
 * `is_archived = false` permite reusar un código al archivar — paridad
 * PlacePos) a los `UQ_products_company_*` solicitados en la spec. Por eso NO
 * creamos índices duplicados con nombres nuevos: re-aseguramos los canónicos
 * con `CREATE UNIQUE INDEX IF NOT EXISTS`.
 *
 * --------------------------------------------------------------------------
 * Qué hace esta migración (idempotente)
 * --------------------------------------------------------------------------
 *
 *   1. DEDUPE per-company de `sku_code`, `bar_code` y `name` sobre filas
 *      ACTIVAS, conservando el de menor `id`. Al resto le agrega un sufijo
 *      numérico incremental (empezando por su nº de orden dentro del grupo)
 *      y verifica que el destino esté libre DENTRO de la misma company antes
 *      de asignarlo. Defensivo: en un entorno fresco los índices ya impiden
 *      duplicados, así que estos bloques no tocan nada; protege entornos con
 *      datos de volumen migrados sin los índices.
 *
 *   2. Re-asegura los tres índices únicos parciales con `IF NOT EXISTS`. En
 *      un entorno donde ya existen (lo normal), es un no-op.
 *
 * El dedupe corre ANTES de crear los índices: si hubiera duplicados, crear el
 * índice único fallaría. Como aquí los índices ya existen, el dedupe es la
 * red de seguridad para reaplicar la migración en una BD que perdió los
 * índices.
 *
 * down(): elimina únicamente los índices que esta migración pudo haber
 * creado. NO revierte el dedupe (renombrar de vuelta sería ambiguo y
 * destructivo — los renombres son aditivos e irreversibles por diseño,
 * §8 CLAUDE.md).
 */
export class DedupeAndReassureProductUniqueIndexes1747011740000 implements MigrationInterface {
  name = 'DedupeAndReassureProductUniqueIndexes1747011740000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ----------------------------------------------------------------------
    // 1a. Dedupe de sku_code por company (solo activos, sku no vacío).
    // ----------------------------------------------------------------------
    await queryRunner.query(`
      DO $$
      DECLARE r RECORD; new_val text; n int;
      BEGIN
        FOR r IN
          SELECT id, company_id, sku_code, rn FROM (
            SELECT id, company_id, sku_code,
                   ROW_NUMBER() OVER (PARTITION BY company_id, sku_code ORDER BY id) rn
            FROM products
            WHERE sku_code IS NOT NULL AND sku_code <> '' AND is_archived = false
          ) t WHERE t.rn > 1
        LOOP
          n := r.rn;
          LOOP
            new_val := r.sku_code || n::text;
            EXIT WHEN NOT EXISTS (
              SELECT 1 FROM products
              WHERE company_id = r.company_id AND sku_code = new_val AND is_archived = false
            );
            n := n + 1;
          END LOOP;
          UPDATE products SET sku_code = new_val WHERE id = r.id;
        END LOOP;
      END $$;
    `);

    // ----------------------------------------------------------------------
    // 1b. Dedupe de bar_code por company (solo activos, bar_code no vacío).
    // ----------------------------------------------------------------------
    await queryRunner.query(`
      DO $$
      DECLARE r RECORD; new_val text; n int;
      BEGIN
        FOR r IN
          SELECT id, company_id, bar_code, rn FROM (
            SELECT id, company_id, bar_code,
                   ROW_NUMBER() OVER (PARTITION BY company_id, bar_code ORDER BY id) rn
            FROM products
            WHERE bar_code IS NOT NULL AND bar_code <> '' AND is_archived = false
          ) t WHERE t.rn > 1
        LOOP
          n := r.rn;
          LOOP
            new_val := r.bar_code || n::text;
            EXIT WHEN NOT EXISTS (
              SELECT 1 FROM products
              WHERE company_id = r.company_id AND bar_code = new_val AND is_archived = false
            );
            n := n + 1;
          END LOOP;
          UPDATE products SET bar_code = new_val WHERE id = r.id;
        END LOOP;
      END $$;
    `);

    // ----------------------------------------------------------------------
    // 1c. Dedupe de name por company (solo activos). El índice canónico es
    //     case-insensitive (lower(btrim(name))), así que la partición agrupa
    //     por la misma expresión normalizada para detectar las colisiones que
    //     el índice rechazaría. El nuevo valor anexa un sufijo al name original
    //     (preservando su casing) y se valida contra la misma forma normalizada.
    // ----------------------------------------------------------------------
    await queryRunner.query(`
      DO $$
      DECLARE r RECORD; new_val text; n int;
      BEGIN
        FOR r IN
          SELECT id, company_id, name, rn FROM (
            SELECT id, company_id, name,
                   ROW_NUMBER() OVER (
                     PARTITION BY company_id, lower(btrim(name)) ORDER BY id
                   ) rn
            FROM products
            WHERE is_archived = false
          ) t WHERE t.rn > 1
        LOOP
          n := r.rn;
          LOOP
            new_val := btrim(r.name) || ' ' || n::text;
            EXIT WHEN NOT EXISTS (
              SELECT 1 FROM products
              WHERE company_id = r.company_id
                AND lower(btrim(name)) = lower(btrim(new_val))
                AND is_archived = false
            );
            n := n + 1;
          END LOOP;
          UPDATE products SET name = new_val WHERE id = r.id;
        END LOOP;
      END $$;
    `);

    // ----------------------------------------------------------------------
    // 2. Reaseguro de los índices únicos parciales canónicos (IF NOT EXISTS).
    //    En un entorno normal ya existen (creados por la migración base) y
    //    estos statements son no-ops.
    // ----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_products_company_sku_unique
      ON products (company_id, sku_code)
      WHERE sku_code IS NOT NULL AND is_archived = false
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_products_company_barcode_unique
      ON products (company_id, bar_code)
      WHERE bar_code IS NOT NULL AND is_archived = false
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_products_company_name_unique
      ON products (company_id, lower(btrim(name)))
      WHERE is_archived = false
    `);
  }

  public async down(): Promise<void> {
    // Intencionalmente vacío: los índices canónicos son propiedad de la
    // migración base `1747008240000-create-products-table.ts`, que ya los
    // borra en su propio `down()`. Borrarlos aquí dejaría el esquema sin las
    // garantías de unicidad esperadas por el resto del módulo (create/update/
    // bulk dependen de ellas). El dedupe (renombres de códigos/nombres) es
    // aditivo e irreversible por diseño (§8 CLAUDE.md).
  }
}
