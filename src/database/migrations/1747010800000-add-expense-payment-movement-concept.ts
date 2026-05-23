import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ola 3B — Añade `EXPENSE_PAYMENT` al enum `movement_concept` para alinear
 * con PlacePos.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * PlacePos emite `FinancialMovement` con `concept = EXPENSE_PAYMENT` al
 * registrar un gasto (`POST /expenses`). El enum cloud actual incluye
 * `EXPENSE` como concepto genérico — heredado de un diseño inicial — pero
 * NO incluye `EXPENSE_PAYMENT`, lo que obliga al caller de `expenses` a usar
 * un nombre divergente y rompe la trazabilidad cruzada con PlacePos en
 * conciliaciones y reportes.
 *
 * Esta migración añade el valor faltante. El caller `CreateExpenseAction` se
 * actualiza en el mismo Ola para usar `EXPENSE_PAYMENT` (paridad estricta
 * con `expenses.routes.ts` de PlacePos). Otros callers que usan `EXPENSE`
 * (no aplica: hoy solo `expenses` lo usa) NO se tocan en esta migración —
 * cualquier cambio adicional requiere análisis individual.
 *
 * --------------------------------------------------------------------------
 * `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE … ADD VALUE` dentro de una transacción.
 * Declaramos `transaction = false` para que el `ALTER TYPE` corra
 * autonomously (mismo patrón que las migraciones 1747010460000 y
 * 1747010640000).
 *
 * --------------------------------------------------------------------------
 * `down()` IRREVERSIBLE
 * --------------------------------------------------------------------------
 *
 * Postgres no soporta `DROP VALUE` directo en un enum. Revertir requeriría
 * renombrar el enum, recrearlo sin el valor y recastear la columna — es
 * destructivo y no debe ejecutarse en producción. No-op intencional.
 */
export class AddExpensePaymentMovementConcept1747010800000 implements MigrationInterface {
  name = 'AddExpensePaymentMovementConcept1747010800000';

  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "movement_concept" ADD VALUE IF NOT EXISTS 'EXPENSE_PAYMENT'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible — ver JSDoc. No-op intencional.
  }
}
