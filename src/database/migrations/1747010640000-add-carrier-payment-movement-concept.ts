import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `CARRIER_PAYMENT` al enum Postgres `movement_concept`.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * PlacePos (`placepos/src/main/database/carrierPaymentOperations.ts`) emite
 * `FinancialMovement` con `concept = MovementConcept.CARRIER_PAYMENT` al
 * registrar un abono a transportista. El enum cloud actual NO incluye este
 * valor — el caller estaba usando `EXPENSE` como fallback, lo que rompe la
 * paridad de reportes financieros (un reporte de movimientos por concepto
 * en cloud no podría separar carrier-payments de gastos genéricos).
 *
 * Esta migración añade el valor. El caller (`process-carrier-payment.action`)
 * se actualiza en el mismo commit para emitir `CARRIER_PAYMENT`.
 *
 * --------------------------------------------------------------------------
 * Por qué `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE ... ADD VALUE` dentro de una transacción
 * (error 25001). Declaramos `transaction = false` para que el ALTER corra
 * autonomously.
 *
 * --------------------------------------------------------------------------
 * `down()` IRREVERSIBLE
 * --------------------------------------------------------------------------
 *
 * Postgres no soporta DROP VALUE en enums. Revertir requeriría recrear el
 * enum y recastear todas las columnas que lo usen. Forward-only.
 */
export class AddCarrierPaymentMovementConcept1747010640000 implements MigrationInterface {
  name = 'AddCarrierPaymentMovementConcept1747010640000';

  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "movement_concept" ADD VALUE IF NOT EXISTS 'CARRIER_PAYMENT'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible — ver JSDoc. No-op intencional.
    //
    // Si se necesita revertir:
    //   1. SELECT count(*) FROM financial_movements WHERE concept = 'CARRIER_PAYMENT';
    //      (debe ser 0 antes de proceder)
    //   2. Renombrar enum, recrearlo sin CARRIER_PAYMENT, recastear columnas.
  }
}
