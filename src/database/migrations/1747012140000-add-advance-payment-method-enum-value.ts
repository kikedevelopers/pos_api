import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Anticipo como medio de pago — añade el valor `ADVANCE` al enum Postgres
 * NATIVO `payment_method`.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * El enum `payment_method` (creado en 1747008900000 con `CASH | TRANSFER`) es
 * COMPARTIDO por `sale_payments` y `purchase_payments`. El nuevo medio de pago
 * ADVANCE (redención de `customers.advance_balance`) persiste
 * `SalePayment.payment_method = 'ADVANCE'`, así que el enum debe incluirlo.
 *
 * --------------------------------------------------------------------------
 * `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE ... ADD VALUE` dentro de una transacción.
 * Declaramos `transaction = false` (mismo patrón que
 * 1747011580000-add-customer-advance-enum-values). `migrationsTransactionMode:
 * 'each'` (ver data-source.ts) respeta esta bandera y corre esta migración
 * fuera de TX.
 *
 * `IF NOT EXISTS` la hace idempotente: re-ejecutarla (o correrla sobre una BD
 * que ya tenga el valor) es no-op.
 *
 * --------------------------------------------------------------------------
 * `down()` IRREVERSIBLE
 * --------------------------------------------------------------------------
 *
 * Postgres no soporta `DROP VALUE` directo en un enum. No-op intencional.
 */
export class AddAdvancePaymentMethodEnumValue1747012140000 implements MigrationInterface {
  name = 'AddAdvancePaymentMethodEnumValue1747012140000';

  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'ADVANCE'`);
  }

  public async down(): Promise<void> {
    // Irreversible — ver JSDoc. No-op intencional.
  }
}
