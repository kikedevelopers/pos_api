import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `BRANCH_TRANSFER` al enum Postgres `movement_concept`.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * Nuevo flujo multi-sucursal: una SUCURSAL puede trasladar dinero (desde un
 * banco o billetera) hacia una caja del NEGOCIO PRINCIPAL del mismo owner.
 * El traslado registra un par de `FinancialMovement` con el mismo
 * `reference_code` en DOS companies:
 *   - `EXPENSE` en la sucursal   → descripción "Egreso - <sucursal>".
 *   - `INCOME`  en el principal  → descripción "Ingreso - <sucursal>".
 *
 * Ambos usan `concept = BRANCH_TRANSFER`, que este ALTER habilita. Sin él,
 * la inserción fallaría (valor de enum inexistente) o habría que degradar a
 * `TRANSFER`, perdiendo la trazabilidad del flujo entre empresas.
 *
 * --------------------------------------------------------------------------
 * Por qué `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE ... ADD VALUE` dentro de una transacción
 * (error 25001). Declaramos `transaction = false` para que el ALTER corra
 * de forma autónoma.
 *
 * --------------------------------------------------------------------------
 * `down()` IRREVERSIBLE
 * --------------------------------------------------------------------------
 *
 * Postgres no soporta DROP VALUE en enums. Revertir requeriría recrear el
 * enum y recastear todas las columnas que lo usen. Forward-only.
 */
export class AddBranchTransferMovementConcept1747012660000 implements MigrationInterface {
  name = 'AddBranchTransferMovementConcept1747012660000';

  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "movement_concept" ADD VALUE IF NOT EXISTS 'BRANCH_TRANSFER'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible — ver JSDoc. No-op intencional.
    //
    // Si se necesita revertir:
    //   1. SELECT count(*) FROM financial_movements WHERE concept = 'BRANCH_TRANSFER';
    //      (debe ser 0 antes de proceder)
    //   2. Renombrar enum, recrearlo sin BRANCH_TRANSFER, recastear columnas.
  }
}
