import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fecha de purga de la imagen de un producto.
 *
 * Al archivar un producto su imagen NO se borra de inmediato: archivar por
 * error es común y recuperar una foto que ya no existe, imposible. En su lugar
 * se marca cuándo puede eliminarse (7 días después, configurable) y un cron
 * diario limpia lo vencido para liberar espacio en el bucket.
 *
 * `NULL` = no hay nada programado, que es el caso de todo producto activo.
 *
 * El índice es PARCIAL: el cron solo pregunta por las filas marcadas, que serán
 * un puñado frente a un catálogo entero, y así el índice no crece con productos
 * que nunca va a mirar.
 *
 * También se corrige el comentario de `products.image`: desde ahora guarda la
 * RUTA DEL OBJETO en el bucket (`inventory_items/<company>/<id>-<rnd>.jpg`), no
 * una URL. La URL se firma al leer y es temporal, así que persistirla sería
 * guardar un dato que caduca.
 */
export class AddProductImagePurgeAt1747012500000 implements MigrationInterface {
  name = 'AddProductImagePurgeAt1747012500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "products"
      ADD COLUMN IF NOT EXISTS "image_purge_at" timestamptz NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "products"."image_purge_at" IS
      'Instante a partir del cual la imagen del bucket puede borrarse (se marca al archivar). NULL = sin purga programada.'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "products"."image" IS
      'Ruta del objeto en Google Cloud Storage (inventory_items/<company_id>/<product_id>-<rnd>.<ext>). NULL si no tiene imagen. La URL se firma al leer.'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_products_image_purge_at"
      ON "products" ("image_purge_at")
      WHERE "image_purge_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_products_image_purge_at"`);
    await queryRunner.query(`
      ALTER TABLE "products" DROP COLUMN IF EXISTS "image_purge_at"
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "products"."image" IS 'URL de imagen. NULL si no se ha cargado.'
    `);
  }
}
