import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `LOAN_DISBURSEMENT` (desembolso de un préstamo) a los enums de
 * movimientos de dinero:
 *
 *   - `movement_concept`: egreso desde un banco o billetera.
 *   - `cash_register_log_type`: egreso desde la caja.
 *
 * Un préstamo NO es un gasto: es dinero que sale y debe volver. Tener su
 * propio concepto evita que se cuente como gasto y deja la trazabilidad del
 * desembolso en Tesorería.
 *
 * `transaction = false`: `ALTER TYPE ... ADD VALUE` no puede usarse en la
 * misma transacción en la que se crea (ver migración BRANCH_TRANSFER).
 * Forward-only: Postgres no permite quitar un valor de un enum.
 */
export class AddLoanDisbursementConcepts1747012970000 implements MigrationInterface {
  name = 'AddLoanDisbursementConcepts1747012970000';

  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "movement_concept" ADD VALUE IF NOT EXISTS 'LOAN_DISBURSEMENT'`,
    );
    await queryRunner.query(
      `ALTER TYPE "cash_register_log_type" ADD VALUE IF NOT EXISTS 'LOAN_DISBURSEMENT'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible (forward-only): Postgres no soporta DROP VALUE en enums.
  }
}
