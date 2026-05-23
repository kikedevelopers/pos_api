import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ola I-3 — Añade `expense_id` a `fixed_expense_periods` con FK a `expenses`.
 *
 * Cada corte pagado debe materializar un `Expense` real (con su débito a la
 * fuente + `FinancialMovement` correspondiente). Esa relación se guarda
 * aquí para que el frontend pueda navegar del corte al gasto sin queries
 * adicionales.
 *
 * `ON DELETE SET NULL`: si en el futuro el `Expense` se anula
 * (soft-delete via `is_archived = true`), la fila se conserva. Si se
 * borrara físicamente (no es el caso pero defensivo), el FK quedaría
 * desreferenciado en lugar de bloquear.
 */
export class AddExpenseIdToFixedExpensePeriods1747010920000 implements MigrationInterface {
  name = 'AddExpenseIdToFixedExpensePeriods1747010920000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "fixed_expense_periods"
      ADD COLUMN "expense_id" bigint NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "fixed_expense_periods"
      ADD CONSTRAINT "fk_fixed_expense_periods_expense_id"
      FOREIGN KEY ("expense_id") REFERENCES "expenses"("id")
      ON DELETE SET NULL ON UPDATE CASCADE
    `);

    // Index parcial: solo periodos con expense asociado se consultan para
    // navegar al gasto desde el corte.
    await queryRunner.query(`
      CREATE INDEX "idx_fixed_expense_periods_expense_id"
      ON "fixed_expense_periods" ("expense_id")
      WHERE "expense_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_fixed_expense_periods_expense_id"`);
    await queryRunner.query(
      `ALTER TABLE "fixed_expense_periods" DROP CONSTRAINT IF EXISTS "fk_fixed_expense_periods_expense_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fixed_expense_periods" DROP COLUMN IF EXISTS "expense_id"`,
    );
  }
}
