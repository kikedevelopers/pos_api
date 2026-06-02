import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Idempotencia en la CREACIÓN de compras — evita compras duplicadas por
 * doble-click / reintento de red en `POST /purchases`. Espejo del mismo guard
 * en ventas (1747011420000).
 *
 * `POST /purchases` aceptaba `client_operation_id` pero NO lo usaba: cada
 * request insertaba una compra nueva. En cloud, la latencia de red deja pasar
 * dos requests antes de que el primero responda → dos compras idénticas.
 *
 *  - `client_operation_id text NULL`: UUID v4 que el cliente genera UNA vez por
 *    intento de registro y reusa en reintentos.
 *  - Índice único PARCIAL `(company_id, client_operation_id)` WHERE NOT NULL:
 *    hace FÍSICAMENTE imposible registrar la misma compra dos veces en una
 *    company. El `CreatePurchaseAction` hace fast-path de replay y recupera la
 *    compra ganadora si dos requests compiten.
 *
 * Parcial: las compras legadas / sin llave quedan con NULL y no entran al
 * índice (varios NULL no colisionan).
 */
export class AddClientOperationIdToPurchases1747011480000 implements MigrationInterface {
  name = 'AddClientOperationIdToPurchases1747011480000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE purchases
      ADD COLUMN IF NOT EXISTS client_operation_id text
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_purchases_client_operation
      ON purchases (company_id, client_operation_id)
      WHERE client_operation_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_purchases_client_operation`);
    await queryRunner.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS client_operation_id`);
  }
}
