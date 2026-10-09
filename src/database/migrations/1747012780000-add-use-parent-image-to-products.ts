import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `use_parent_image` a `products`: una PRESENTACIÓN (fila con `parent_id`)
 * puede VINCULARSE a la imagen de su producto base en vez de subir una copia y
 * ocupar almacenamiento de más.
 *
 * El vínculo es LÓGICO, no una ruta compartida: la presentación deja su propia
 * columna `image` en NULL y, al servir, su `image_url` se resuelve desde la
 * imagen del padre (en tiempo de lectura). Así NUNCA se comparte la ruta del
 * objeto en el bucket, y borrar/reemplazar la imagen del base no deja a la
 * presentación apuntando a la nada (ver `CopyProductImageAction`, que
 * deliberadamente copia el objeto para evitar justo ese riesgo).
 *
 * Solo aplica a presentaciones; bases y combos quedan siempre en `false`.
 */
export class AddUseParentImageToProducts1747012780000 implements MigrationInterface {
  name = 'AddUseParentImageToProducts1747012780000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "products"
        ADD COLUMN IF NOT EXISTS "use_parent_image" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "products"."use_parent_image" IS
      'Presentación vinculada a la imagen del producto base: al servir, su image_url se resuelve desde la imagen del padre. Su propia columna image queda NULL. Solo presentaciones; base/combo en false.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "products"
        DROP COLUMN IF EXISTS "use_parent_image"
    `);
  }
}
