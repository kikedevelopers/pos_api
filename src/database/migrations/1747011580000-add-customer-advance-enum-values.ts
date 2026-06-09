import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Anticipos de cliente — Añade el valor `CUSTOMER_ADVANCE` a los enums
 * `cash_register_log_type` y `movement_concept`.
 *
 * --------------------------------------------------------------------------
 * Motivación / decisión de modelado
 * --------------------------------------------------------------------------
 *
 * El feature "Anticipo de cliente" registra un INGRESO de dinero en la cuenta
 * destino:
 *
 *   - destino `cash_register` → CashRegisterLog(type=CUSTOMER_ADVANCE, IN).
 *   - destino `bank` | `wallet` → FinancialMovement(concept=CUSTOMER_ADVANCE,
 *     INCOME).
 *
 * Ninguno de los dos enums tenía un valor que describiera esta semántica de
 * forma idiomática; reusar `ADJUSTMENT`/`SALE_PAYMENT` mezclaría reportes y
 * perdería trazabilidad. Por eso se añade un valor dedicado en ambos.
 *
 * --------------------------------------------------------------------------
 * `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE … ADD VALUE` dentro de una transacción.
 * Declaramos `transaction = false` (mismo patrón que 1747010800000 y
 * 1747011040000).
 *
 * --------------------------------------------------------------------------
 * `down()` IRREVERSIBLE
 * --------------------------------------------------------------------------
 *
 * Postgres no soporta `DROP VALUE` directo en un enum. No-op intencional.
 */
export class AddCustomerAdvanceEnumValues1747011580000 implements MigrationInterface {
  name = 'AddCustomerAdvanceEnumValues1747011580000';

  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "cash_register_log_type" ADD VALUE IF NOT EXISTS 'CUSTOMER_ADVANCE'`,
    );
    await queryRunner.query(
      `ALTER TYPE "movement_concept" ADD VALUE IF NOT EXISTS 'CUSTOMER_ADVANCE'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible — ver JSDoc. No-op intencional.
  }
}
