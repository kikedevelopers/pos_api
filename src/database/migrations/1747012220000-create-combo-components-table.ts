import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RECETA DEL PRODUCTO COMBO — paridad placepos (`AddComboComponents1792400000000`).
 *
 * Crea `combo_components`: cuánto consume un producto COMBO de cada producto
 * BASE, en la unidad MÍNIMA de ese base (la misma en la que vive
 * `products.stock`). El valor `COMBO` del enum `product_type` ya existía desde
 * el esquema inicial; esta migración solo agrega la tabla que lo hace funcional.
 *
 * No toca `products` ni ninguna tabla de ventas: los productos existentes
 * quedan intactos y el catálogo actual sigue comportándose igual.
 *
 * Invariantes en DB:
 *   - `quantity > 0`.
 *   - un combo no puede llevarse a sí mismo.
 *   - un componente aparece UNA sola vez por combo dentro de la company.
 *   - borrar el combo borra su receta (CASCADE).
 *
 * Convención de FKs del proyecto (ver `EnableTenantCascadeDelete1747011300000`):
 *   - `company_id` → ON DELETE CASCADE: borrar la company barre el tenant entero.
 *   - FK intra-tenant a `products` → NO ACTION (no RESTRICT): NO ACTION se
 *     verifica al FINAL del statement, así la cascada desde `companies` no
 *     choca, pero un borrado suelto de un producto que está en una receta sigue
 *     fallando.
 *
 * Reversible por completo: la receta es dato maestro del combo, y si se
 * revierte la migración el tipo COMBO vuelve a quedar inerte (como estaba).
 */
export class CreateComboComponentsTable1747012220000 implements MigrationInterface {
  name = 'CreateComboComponentsTable1747012220000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "combo_components" (
        "id"                   bigserial PRIMARY KEY,
        "company_id"           bigint NOT NULL,
        "combo_product_id"     bigint NOT NULL,
        "component_product_id" bigint NOT NULL,
        "quantity"             numeric(15,4) NOT NULL,
        "created_at"           timestamptz NOT NULL DEFAULT now(),
        "updated_at"           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_combo_components_quantity_positive" CHECK ("quantity" > 0),
        CONSTRAINT "chk_combo_components_not_self"
          CHECK ("combo_product_id" <> "component_product_id"),
        CONSTRAINT "fk_combo_components_company_id"
          FOREIGN KEY ("company_id") REFERENCES "companies" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "fk_combo_components_combo_product_id"
          FOREIGN KEY ("combo_product_id") REFERENCES "products" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "fk_combo_components_component_product_id"
          FOREIGN KEY ("component_product_id") REFERENCES "products" ("id")
          ON DELETE NO ACTION ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_combo_components_company_id"
      ON "combo_components" ("company_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_combo_components_combo"
      ON "combo_components" ("combo_product_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_combo_components_component"
      ON "combo_components" ("component_product_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_combo_components_combo_component"
      ON "combo_components" ("company_id", "combo_product_id", "component_product_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "combo_components"`);
  }
}
