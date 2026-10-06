import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade la MESA y el SALÓN (opcionales) a un pedido/venta — módulo restaurante.
 *
 * Cuando un pedido se envía a una mesa (botón "Enviar a" del POS de
 * restaurantes), el `sale_invoice` guarda a qué mesa (`table_id`) y, si se eligió
 * por salón, a qué salón (`salon_id`) pertenece, más los snapshots de nombre
 * (`table_name` / `salon_name`) para auditoría histórica — igual que
 * `customer_name`. La mesa queda OCUPADA hasta que el pedido se cobre.
 *
 * Todo es OPCIONAL/nullable: el POS retail crea pedidos sin mesa y sigue igual.
 * FKs `ON DELETE SET NULL`: borrar una mesa/salón no borra la venta (conserva el
 * snapshot de nombre como historia).
 */
export class AddTableToSaleInvoices1747012720000 implements MigrationInterface {
  name = 'AddTableToSaleInvoices1747012720000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
        ADD COLUMN IF NOT EXISTS "table_id" bigint NULL,
        ADD COLUMN IF NOT EXISTS "salon_id" bigint NULL,
        ADD COLUMN IF NOT EXISTS "table_name" text NULL,
        ADD COLUMN IF NOT EXISTS "salon_name" text NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "sale_invoices"."table_id" IS
      'Mesa a la que se envió el pedido (modo restaurante). NULL en retail. Ocupa la mesa hasta cobrar.'
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_sale_invoices_table_id'
        ) THEN
          ALTER TABLE "sale_invoices"
          ADD CONSTRAINT "fk_sale_invoices_table_id"
          FOREIGN KEY ("table_id") REFERENCES "restaurant_tables" ("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_sale_invoices_salon_id'
        ) THEN
          ALTER TABLE "sale_invoices"
          ADD CONSTRAINT "fk_sale_invoices_salon_id"
          FOREIGN KEY ("salon_id") REFERENCES "salons" ("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sale_invoices_table_id"
      ON "sale_invoices" ("table_id")
      WHERE table_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "idx_sale_invoices_table_id"');
    await queryRunner.query(
      'ALTER TABLE "sale_invoices" DROP CONSTRAINT IF EXISTS "fk_sale_invoices_salon_id"',
    );
    await queryRunner.query(
      'ALTER TABLE "sale_invoices" DROP CONSTRAINT IF EXISTS "fk_sale_invoices_table_id"',
    );
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
        DROP COLUMN IF EXISTS "salon_name",
        DROP COLUMN IF EXISTS "table_name",
        DROP COLUMN IF EXISTS "salon_id",
        DROP COLUMN IF EXISTS "table_id"
    `);
  }
}
