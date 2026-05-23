import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `payment_accounts JSONB NOT NULL DEFAULT '[]'::jsonb` a la tabla
 * `suppliers` — paridad placepos
 * (`migrations/1788400000000-AddPaymentAccountsToSuppliers.ts`).
 *
 * El frontend Electron envía un array `payment_accounts` al crear/editar un
 * proveedor con las cuentas a las que se le puede consignar (entity_name,
 * account_type, account_number, document_type, document_number,
 * agreement_number). Hasta esta migración pos_api no tenía la columna y el
 * `ValidationPipe` rechazaba el campo con `forbidNonWhitelisted` → 400.
 *
 * Se persiste como JSONB porque las cuentas son siempre dependientes del
 * proveedor y nunca se consultan por sí solas — mismo diseño que placepos.
 * Default `'[]'::jsonb` cubre el backfill de filas existentes sin schema
 * change adicional.
 */
export class AddPaymentAccountsToSuppliers1747010980000 implements MigrationInterface {
  name = 'AddPaymentAccountsToSuppliers1747010980000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE suppliers
      ADD COLUMN IF NOT EXISTS payment_accounts JSONB NOT NULL DEFAULT '[]'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE suppliers DROP COLUMN IF EXISTS payment_accounts
    `);
  }
}
