import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 3.5 — Relaja los CHECK constraints `chk_financial_movements_source_consistency`
 * y `chk_financial_movements_destination_consistency`.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * Los CHECKs originales obligaban a `(type IS NULL AND id IS NULL)` o
 * `(type IS NOT NULL AND id IS NOT NULL)`. Demasiado estricto para flujos
 * legítimos:
 *
 *   - `carrier-payments` CASH: el FM "marcador" lleva `source_type='cash_register'`
 *     y `source_id=null` cuando se quiere documentar que el dinero salió de la
 *     caja del actor sin atar el id de un row específico (decisión de Fase
 *     11 — antes se usaba el id de la caja abierta, lo cual no aplica con el
 *     modelo permanente per-user).
 *   - `external` sin id: los FMs de gasto contra "externo no rastreado"
 *     necesitan source/destination='external' sin id concreto.
 *
 * Reemplazamos los dos CHECKs por una versión MÁS LAXA:
 *
 *   source_type IS NULL                   -- sin source registrado
 *   OR source_type IN ('cash_register', 'external')  -- ambos types admiten id null
 *   OR source_id IS NOT NULL              -- otros types (bank, wallet) requieren id
 *
 * Idem destination.
 *
 * El CHECK `chk_financial_movements_has_endpoint` (al menos uno de source o
 * destination NOT NULL) se mantiene intacto.
 */
export class RelaxFinancialMovementsSourceCheck1747010220000 implements MigrationInterface {
  name = 'RelaxFinancialMovementsSourceCheck1747010220000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop CHECKs estrictos.
    await queryRunner.query(
      `ALTER TABLE "financial_movements" DROP CONSTRAINT IF EXISTS "chk_financial_movements_source_consistency"`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_movements" DROP CONSTRAINT IF EXISTS "chk_financial_movements_destination_consistency"`,
    );

    // 2. Add CHECKs laxos.
    await queryRunner.query(`
      ALTER TABLE "financial_movements"
      ADD CONSTRAINT "chk_financial_movements_source_consistency" CHECK (
        source_type IS NULL
        OR source_type IN ('cash_register', 'external')
        OR source_id IS NOT NULL
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "financial_movements"
      ADD CONSTRAINT "chk_financial_movements_destination_consistency" CHECK (
        destination_type IS NULL
        OR destination_type IN ('cash_register', 'external')
        OR destination_id IS NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop CHECKs laxos.
    await queryRunner.query(
      `ALTER TABLE "financial_movements" DROP CONSTRAINT IF EXISTS "chk_financial_movements_destination_consistency"`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_movements" DROP CONSTRAINT IF EXISTS "chk_financial_movements_source_consistency"`,
    );

    // 2. Restaurar CHECKs estrictos.
    await queryRunner.query(`
      ALTER TABLE "financial_movements"
      ADD CONSTRAINT "chk_financial_movements_source_consistency" CHECK (
        (source_type IS NULL AND source_id IS NULL)
        OR (source_type IS NOT NULL AND source_id IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "financial_movements"
      ADD CONSTRAINT "chk_financial_movements_destination_consistency" CHECK (
        (destination_type IS NULL AND destination_id IS NULL)
        OR (destination_type IS NOT NULL AND destination_id IS NOT NULL)
      )
    `);
  }
}
