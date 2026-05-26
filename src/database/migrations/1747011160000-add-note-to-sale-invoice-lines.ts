import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade `note` (text nullable) a `sale_invoice_lines` — nota por línea de
 * venta (una por producto/línea).
 *
 * Contrato REST: cada item de `POST /sales` acepta un `note?: string | null`
 * opcional que se persiste en su línea; `GET /sales/:id` lo devuelve por
 * línea. Espejo del `note` por línea del servidor Express offline de PlacePos.
 *
 * La nota a NIVEL TICKET (`sale_invoices.notes`) ya existe en una migración
 * previa — esta migración NO la toca.
 *
 * Cambio aditivo (columna nullable, sin default): no requiere backfill ni
 * bloquea filas existentes.
 */
export class AddNoteToSaleInvoiceLines1747011160000 implements MigrationInterface {
  name = 'AddNoteToSaleInvoiceLines1747011160000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sale_invoice_lines"
      ADD COLUMN "note" text NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sale_invoice_lines" DROP COLUMN IF EXISTS "note"`);
  }
}
