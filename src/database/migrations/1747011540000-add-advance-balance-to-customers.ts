import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Anticipos de cliente — Añade la columna `advance_balance` a `customers`.
 *
 * --------------------------------------------------------------------------
 * Motivación / decisión de modelado
 * --------------------------------------------------------------------------
 *
 * El feature "Anticipo de cliente" (ver `CONTRACT_customer_advance_archive.md`)
 * exige un saldo DEDICADO de anticipos, separado del `balance` signed de
 * cartera. La decisión del usuario es NO reusar `balance` para no mezclar la
 * semántica de cartera (crédito/deuda) con la de dinero recibido por
 * adelantado.
 *
 *   - `advance_balance numeric(15,2)` — Money rule (paridad con `balance`).
 *   - `DEFAULT 0` y `NOT NULL` — todo cliente existente arranca en 0.
 *   - CHECK `>= 0` — invariante: el anticipo nunca es negativo (en esta
 *     entrega no hay consumo ni reversa).
 *
 * Aditiva y backward-compatible: las filas existentes toman el default 0 sin
 * backfill explícito.
 */
export class AddAdvanceBalanceToCustomers1747011540000 implements MigrationInterface {
  name = 'AddAdvanceBalanceToCustomers1747011540000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'customers',
      new TableColumn({
        name: 'advance_balance',
        type: 'numeric',
        precision: 15,
        scale: 2,
        isNullable: false,
        default: '0',
        comment:
          'Saldo de anticipos del cliente (>= 0). Se incrementa al registrar un anticipo. Distinto de balance.',
      }),
    );

    await queryRunner.query(`
      ALTER TABLE customers
      ADD CONSTRAINT chk_customers_advance_balance_non_negative
      CHECK (advance_balance >= 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE customers DROP CONSTRAINT IF EXISTS chk_customers_advance_balance_non_negative',
    );
    await queryRunner.dropColumn('customers', 'advance_balance');
  }
}
