import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Relaja el CHECK `chk_purchases_received_consistency`: para marcar una compra
 * como RECEIVED ya NO se exige transportista (`carrier_name`), solo receptor
 * (`received_by`) y fecha (`received_at`).
 *
 * Motivo: la mayoría de compras no tienen flete (`carrier_name` NULL),
 * incluidas TODAS las migradas desde placepos offline. Con el CHECK anterior,
 * recibir esas compras violaba el constraint (23514) y se filtraba como HTTP
 * 500. Paridad con placepos, que al recibir solo setea status/received_by/
 * received_at.
 */
export class RelaxPurchaseReceivedCarrier1747011360000 implements MigrationInterface {
  name = 'RelaxPurchaseReceivedCarrier1747011360000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "chk_purchases_received_consistency"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" ADD CONSTRAINT "chk_purchases_received_consistency" CHECK (
        status = 'PENDING'
        OR (received_at IS NOT NULL AND length(btrim(coalesce(received_by, ''))) > 0)
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "chk_purchases_received_consistency"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" ADD CONSTRAINT "chk_purchases_received_consistency" CHECK (
        status = 'PENDING'
        OR (
          received_at IS NOT NULL
          AND length(btrim(coalesce(carrier_name, ''))) > 0
          AND length(btrim(coalesce(received_by, ''))) > 0
        )
      )`,
    );
  }
}
