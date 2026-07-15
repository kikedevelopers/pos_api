import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Anticipo como medio de pago — habilita `account_type = 'customer_advance'`
 * en `sale_payments`.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * El nuevo medio de pago ADVANCE (redención de `customers.advance_balance`)
 * inserta un `SalePayment` con `account_type = 'customer_advance'` y
 * `account_id = customers.id`. El CHECK original
 * (`chk_sale_payments_account_type_values`) solo admitía
 * `('wallet','bank','cash_register')`; lo reemplazamos para incluir el nuevo
 * valor. Un pago ADVANCE NO mueve una cuenta de dinero real: el efectivo/banco
 * ya ingresó al CREAR el anticipo, así que aquí solo se descuenta
 * `advance_balance`.
 *
 * --------------------------------------------------------------------------
 * Transaccional
 * --------------------------------------------------------------------------
 *
 * DROP + ADD de un CHECK constraint SÍ admite transacción (a diferencia de
 * `ALTER TYPE ... ADD VALUE`). Se ejecuta en la TX por defecto de la migración.
 * No hay filas con el nuevo valor todavía, así que el ADD no falla la
 * validación de datos existentes.
 */
export class AddSalePaymentCustomerAdvanceAccountType1747012120000 implements MigrationInterface {
  name = 'AddSalePaymentCustomerAdvanceAccountType1747012120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sale_payments" DROP CONSTRAINT IF EXISTS "chk_sale_payments_account_type_values"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_payments" ADD CONSTRAINT "chk_sale_payments_account_type_values" ` +
        `CHECK (account_type IN ('wallet', 'bank', 'cash_register', 'customer_advance'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversa al set original. Si existieran pagos 'customer_advance' este ADD
    // fallaría — es el comportamiento correcto (no se puede revertir sin perder
    // integridad). En prod las migraciones son additivas; este down es para dev.
    await queryRunner.query(
      `ALTER TABLE "sale_payments" DROP CONSTRAINT IF EXISTS "chk_sale_payments_account_type_values"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_payments" ADD CONSTRAINT "chk_sale_payments_account_type_values" ` +
        `CHECK (account_type IN ('wallet', 'bank', 'cash_register'))`,
    );
  }
}
