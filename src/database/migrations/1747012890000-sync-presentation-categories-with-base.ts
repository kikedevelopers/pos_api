import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill: cada presentación toma la categoría de su producto base.
 *
 * Regla de negocio: una presentación está amarrada a la categoría de su base
 * (igual que al IVA). Antes, cambiar la categoría del base NO se propagaba a
 * sus presentaciones, así que quedaron familias desalineadas. Esta migración
 * las realinea una sola vez; desde `UpdateProductAction` la propagación es
 * automática.
 *
 * Idempotente (solo toca filas distintas) y acotada al mismo tenant.
 * `down` es no-op: la categoría previa de cada presentación no se conserva.
 */
export class SyncPresentationCategoriesWithBase1747012890000 implements MigrationInterface {
  name = 'SyncPresentationCategoriesWithBase1747012890000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "products" AS child
         SET "category_id" = parent."category_id"
        FROM "products" AS parent
       WHERE child."parent_id" = parent."id"
         AND child."company_id" = parent."company_id"
         AND child."category_id" IS DISTINCT FROM parent."category_id"
    `);
  }

  public async down(): Promise<void> {
    // No reversible: no se guarda la categoría anterior de cada presentación.
  }
}
