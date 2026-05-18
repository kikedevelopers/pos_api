import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 3.5 — Añade `invoice_date` e `invoice_number` a `purchases`.
 *
 * Espejo PlacePos: `Purchase` lleva ambos campos para registrar la factura
 * física del proveedor. `invoice_number` puede ser NULL ("Remisión" o compras
 * sin número formal). Sin UNIQUE — PlacePos permite duplicados intencionales
 * por casos de devoluciones / cambios.
 */
export class AddInvoiceFieldsToPurchases1747010280000 implements MigrationInterface {
  name = 'AddInvoiceFieldsToPurchases1747010280000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "purchases"
      ADD COLUMN "invoice_date" date NULL,
      ADD COLUMN "invoice_number" varchar(64) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "purchases"
      DROP COLUMN IF EXISTS "invoice_number",
      DROP COLUMN IF EXISTS "invoice_date"
    `);
  }
}
