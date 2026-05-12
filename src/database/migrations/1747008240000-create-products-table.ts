import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 3 — Crea el tipo enum `product_type` y la tabla `products`.
 *
 * Contexto del dominio:
 *
 *   Un `Product` es la unidad básica del catálogo. PlacePos lo trata como
 *   un nodo de árbol opcional (`parent_id` reflexivo) para soportar
 *   combos/bundles. El campo `product_type` discrimina entre item plano
 *   (`SIMPLE`) y agrupación de items (`COMBO`).
 *
 * --------------------------------------------------------------------------
 * Divergencias intencionales vs PlacePos local
 * --------------------------------------------------------------------------
 *
 *   1. **Multi-tenancy**: tabla con `company_id NOT NULL` (FK a `companies`).
 *      Todos los UNIQUE pasan a ser per-company (parciales).
 *
 *   2. **Valores del enum**: PlacePos usa `('SIMPLE', 'COMBO')`. Mantenemos
 *      esos mismos valores en mayúscula para paridad byte-por-byte del
 *      contrato HTTP. (El usuario solicitó `'simple'/'bundle'` pero la regla
 *      "espejo de PlacePos" tiene precedencia — divergir rompería el
 *      cliente Electron.)
 *
 *   3. **Sin `stock`/`hash`/`is_purchasable`**: PlacePos guarda estos
 *      campos en `products`. Aquí los OMITIMOS porque la Fase 3 sólo
 *      especifica catálogo; el stock vive en otra entidad en fases
 *      posteriores (inventario por warehouse) y `hash`/`is_purchasable`
 *      son campos secundarios que se añadirán cuando lleguen los flujos
 *      de compras (Fase 5). Documentado como divergencia BACKWARDS-COMPAT
 *      (añadir campos opcionales luego no rompe el contrato).
 *
 *   4. **`updated_by` / `updated_by_id`**: incluidos para auditoría —
 *      espejo PlacePos.
 *
 * --------------------------------------------------------------------------
 * Índices y UNIQUEs
 * --------------------------------------------------------------------------
 *
 *   - `idx_products_company_id` — FK.
 *   - `idx_products_company_pos` — `(company_id, is_archived, show_in_pos)`
 *     parcial. Soporta la query caliente `GET /inventory` (listado POS).
 *   - `idx_products_company_sku_unique` — UNIQUE parcial per-company sobre
 *     `sku_code` donde `sku_code IS NOT NULL AND is_archived = false`.
 *   - `idx_products_company_barcode_unique` — idem para `bar_code`.
 *   - `idx_products_company_name_unique` — UNIQUE parcial per-company
 *     sobre `lower(btrim(name))` donde `is_archived = false`. Espejo de
 *     `Product.name UNIQUE` de PlacePos, pero por-tenant.
 *   - `idx_products_parent_id` — soporta el sort de hijos en `GET /inventory`.
 *
 * --------------------------------------------------------------------------
 * FK reflexiva `parent_id`
 * --------------------------------------------------------------------------
 *
 * `ON DELETE RESTRICT` — no se puede borrar un producto padre que tenga
 * hijos. Para "borrar" un combo, primero hay que archivar/recolocar los
 * hijos. El service NO soporta borrado físico — sólo archivado.
 *
 * NO existe CHECK que valide `parent.company_id = child.company_id` —
 * la coherencia es responsabilidad del service (asignar `company_id` desde
 * `req.user.company_id` y validar que el `parent_id` pertenezca al mismo
 * tenant antes de insertar).
 */
export class CreateProductsTable1747008240000 implements MigrationInterface {
  name = 'CreateProductsTable1747008240000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum nativo de Postgres — paridad con PlacePos.
    await queryRunner.query(`
      CREATE TYPE product_type AS ENUM ('SIMPLE', 'COMBO')
    `);

    // 2. Tabla products.
    await queryRunner.createTable(
      new Table({
        name: 'products',
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
              'Tenant al que pertenece el producto. Asignado por el service desde req.user.company_id.',
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'product_type',
            type: 'product_type',
            isNullable: false,
            default: `'SIMPLE'`,
            enumName: 'product_type',
          },
          {
            name: 'parent_id',
            type: 'bigint',
            isNullable: true,
            comment: 'FK reflexiva. NULL para producto raíz; bigint hacia products.id para combos.',
          },
          {
            name: 'sku_code',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'bar_code',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'packaging_id',
            type: 'bigint',
            isNullable: true,
            comment: 'FK opcional a packagings. ON DELETE SET NULL.',
          },
          {
            name: 'cost',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Costo unitario. numeric(15,2) — §2.5 CLAUDE.md.',
          },
          {
            name: 'image',
            type: 'text',
            isNullable: true,
            comment: 'URL de imagen. NULL si no se ha cargado.',
          },
          {
            name: 'show_in_pos',
            type: 'boolean',
            isNullable: false,
            default: true,
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment: 'Soft-delete convención PlacePos.',
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
            name: 'updated_by',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'updated_by_id',
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
            name: 'chk_products_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
          {
            name: 'chk_products_cost_non_negative',
            expression: 'cost >= 0',
          },
          {
            name: 'chk_products_parent_self_ref',
            // Un producto no puede ser su propio padre (ciclo trivial).
            // Ciclos más largos requerirían un trigger; por ahora confiamos
            // en el service para no crearlos.
            expression: 'parent_id IS NULL OR parent_id <> id',
          },
        ],
      }),
      true,
    );

    // 3. FK a companies (RESTRICT — no borrar company con productos).
    await queryRunner.createForeignKey(
      'products',
      new TableForeignKey({
        name: 'fk_products_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. FK reflexiva a products (parent_id).
    //    RESTRICT: no borrar un padre que tenga hijos. Soft-delete vía
    //    is_archived. El servicio decide qué hacer con la cadena.
    await queryRunner.createForeignKey(
      'products',
      new TableForeignKey({
        name: 'fk_products_parent_id',
        columnNames: ['parent_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 5. FK a packagings (SET NULL — archivar/borrar empaque desliga al
    //    producto sin romperlo). PlacePos hace lo mismo.
    await queryRunner.createForeignKey(
      'products',
      new TableForeignKey({
        name: 'fk_products_packaging_id',
        columnNames: ['packaging_id'],
        referencedTableName: 'packagings',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );

    // 6. Índice base por company (FK + filtro multi-tenant).
    await queryRunner.createIndex(
      'products',
      new TableIndex({
        name: 'idx_products_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 7. Índice compuesto parcial para listado POS.
    //    `GET /inventory` filtra `is_archived = false`. Subdivide por
    //    `show_in_pos` para acelerar dashboards / pantallas POS.
    await queryRunner.query(`
      CREATE INDEX idx_products_company_pos
      ON products (company_id, show_in_pos)
      WHERE is_archived = false
    `);

    // 8. UNIQUE parciales per-company (solo activos).
    //    Razón del PARCIAL: archivar libera el código para reuso. Esto
    //    espeja la semántica de PlacePos cuando el SKU/barcode es null.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_products_company_sku_unique
      ON products (company_id, sku_code)
      WHERE sku_code IS NOT NULL AND is_archived = false
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_products_company_barcode_unique
      ON products (company_id, bar_code)
      WHERE bar_code IS NOT NULL AND is_archived = false
    `);

    // 9. UNIQUE per-company sobre `lower(btrim(name))` para activos.
    //    PlacePos lo declara como UNIQUE global; aquí lo bajamos a per-tenant
    //    (regla de multi-tenancy). Defensa para que dos productos activos
    //    de la misma company no compartan nombre.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_products_company_name_unique
      ON products (company_id, lower(btrim(name)))
      WHERE is_archived = false
    `);

    // 10. Índice por parent_id — el listado ordena hijos por parent. Sin
    //     este índice el sort sería seq scan en catálogos grandes.
    await queryRunner.query(`
      CREATE INDEX idx_products_parent_id
      ON products (parent_id)
      WHERE parent_id IS NOT NULL
    `);

    // 11. Índice por packaging_id — para listar productos por empaque
    //     y para que el SET NULL de packagings no degrade en seq scan.
    await queryRunner.query(`
      CREATE INDEX idx_products_packaging_id
      ON products (packaging_id)
      WHERE packaging_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_products_packaging_id');
    await queryRunner.query('DROP INDEX IF EXISTS idx_products_parent_id');
    await queryRunner.query('DROP INDEX IF EXISTS idx_products_company_name_unique');
    await queryRunner.query('DROP INDEX IF EXISTS idx_products_company_barcode_unique');
    await queryRunner.query('DROP INDEX IF EXISTS idx_products_company_sku_unique');
    await queryRunner.query('DROP INDEX IF EXISTS idx_products_company_pos');
    await queryRunner.dropIndex('products', 'idx_products_company_id');
    await queryRunner.dropForeignKey('products', 'fk_products_packaging_id');
    await queryRunner.dropForeignKey('products', 'fk_products_parent_id');
    await queryRunner.dropForeignKey('products', 'fk_products_company_id');
    await queryRunner.dropTable('products');
    await queryRunner.query('DROP TYPE IF EXISTS product_type');
  }
}
