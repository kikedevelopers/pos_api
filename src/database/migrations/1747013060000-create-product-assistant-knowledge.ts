import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Conocimiento del catálogo para el asistente de ventas.
 *
 * 1) `product_assistant_profiles`: ficha "Para el asistente" de un producto BASE
 *    (sus presentaciones la heredan): descripción, para qué sirve, características
 *    clave-valor, cómo lo llaman los clientes y productos relacionados
 *    (complemento / versión superior / alternativa). Una fila por producto.
 *
 * 2) `product_search_embeddings`: vector de significado (Gemini, 768 dims,
 *    normalizado) de cada familia (base + presentaciones + ficha), para buscar
 *    por NECESIDAD ("algo para hamburguesa y papas") y no solo por nombre.
 *    `text_hash` detecta cuándo hay que recalcularlo. Se guarda como `real[]`
 *    (la imagen de Postgres no trae pgvector); la similitud se calcula en el API.
 */
export class CreateProductAssistantKnowledge1747013060000 implements MigrationInterface {
  name = 'CreateProductAssistantKnowledge1747013060000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "product_assistant_profiles" (
        "id"          bigserial   PRIMARY KEY,
        "company_id"  bigint      NOT NULL,
        "product_id"  bigint      NOT NULL,
        "description" text        NOT NULL DEFAULT '',
        "uses"        jsonb       NOT NULL DEFAULT '[]'::jsonb,
        "attributes"  jsonb       NOT NULL DEFAULT '[]'::jsonb,
        "aliases"     jsonb       NOT NULL DEFAULT '[]'::jsonb,
        "related"     jsonb       NOT NULL DEFAULT '[]'::jsonb,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_product_assistant_profiles_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "fk_product_assistant_profiles_product_id" FOREIGN KEY ("product_id")
          REFERENCES "products" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_product_assistant_profiles_description_len"
          CHECK (length("description") <= 1000)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_product_assistant_profiles_product_unique"
        ON "product_assistant_profiles" ("product_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_product_assistant_profiles_company"
        ON "product_assistant_profiles" ("company_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "product_search_embeddings" (
        "id"         bigserial   PRIMARY KEY,
        "company_id" bigint      NOT NULL,
        "product_id" bigint      NOT NULL,
        "model"      varchar(64) NOT NULL,
        "text_hash"  char(64)    NOT NULL,
        "embedding"  real[]      NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_product_search_embeddings_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "fk_product_search_embeddings_product_id" FOREIGN KEY ("product_id")
          REFERENCES "products" ("id") ON UPDATE CASCADE ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_product_search_embeddings_product_unique"
        ON "product_search_embeddings" ("product_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_product_search_embeddings_company"
        ON "product_search_embeddings" ("company_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "product_search_embeddings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "product_assistant_profiles"`);
  }
}
