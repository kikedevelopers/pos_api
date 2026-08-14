import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enlaza el cobro de una nota débito con la nota que lo originó.
 *
 * Cuando se añaden productos a una venta ya cobrada se emite una nota débito y
 * el cliente paga la diferencia en el momento. Ese cobro es dinero real que
 * entra a la caja, así que tiene que existir como pago de la venta: de lo
 * contrario la venta figura cobrada por su total viejo (27.000 cuando vale
 * 53.946), la ganancia sale diluida y la Meta del mes —que se calcula sobre lo
 * COBRADO— se queda corta con plata que ya está en el cajón.
 *
 * La columna permite distinguirlo de un cobro normal para mostrarlo como
 * "corrección por nota débito" en la lista de abonos. Es nullable: los pagos
 * normales no la usan, y los 16 cobros históricos que nunca se registraron no
 * se inventan aquí — eso sería fabricar movimientos de caja que nadie hizo.
 */
export class AddCreditNoteIdToSalePayments1747012380000 implements MigrationInterface {
  name = 'AddCreditNoteIdToSalePayments1747012380000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sale_payments"
      ADD COLUMN IF NOT EXISTS "credit_note_id" bigint NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "sale_payments"
      ADD CONSTRAINT "fk_sale_payments_credit_note_id"
      FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
    `);

    // Parcial: solo los pagos que SON una corrección. Los normales no entran al
    // índice y no lo engordan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sale_payments_credit_note_id"
      ON "sale_payments" ("credit_note_id")
      WHERE "credit_note_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sale_payments_credit_note_id"`);
    await queryRunner.query(`
      ALTER TABLE "sale_payments" DROP CONSTRAINT IF EXISTS "fk_sale_payments_credit_note_id"
    `);
    await queryRunner.query(`ALTER TABLE "sale_payments" DROP COLUMN IF EXISTS "credit_note_id"`);
  }
}
