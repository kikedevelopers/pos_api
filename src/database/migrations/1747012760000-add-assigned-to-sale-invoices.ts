import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade el EMPLEADO ASIGNADO (opcional) a un pedido — feature RETAIL "Compartir
 * pedido para alistar".
 *
 * Cuando un owner/admin comparte un pedido (ticket_type=ORDER) con otro empleado
 * para que lo aliste, el `sale_invoice` guarda a qué empleado se asignó vía su
 * User espejo (`assigned_to_user_id` = `users.id`, homogéneo con `created_by_id`)
 * y un snapshot del nombre (`assigned_to_name`) para mostrarlo sin join.
 *
 * Es OPCIONAL/nullable: los pedidos/ventas existentes siguen igual. La columna
 * SOLO amplía la visibilidad del asignado (lo ve en su feed); NO toca la
 * atribución (`created_by_id`), así que los informes de totales nunca lo
 * doble-cuentan. FK `ON DELETE SET NULL`: borrar el usuario no borra la venta.
 *
 * Índice parcial para acelerar el OR de visibilidad del feed (igual criterio que
 * `idx_sale_invoices_table_id`).
 */
export class AddAssignedToSaleInvoices1747012760000 implements MigrationInterface {
  name = 'AddAssignedToSaleInvoices1747012760000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
        ADD COLUMN IF NOT EXISTS "assigned_to_user_id" bigint NULL,
        ADD COLUMN IF NOT EXISTS "assigned_to_name" text NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "sale_invoices"."assigned_to_user_id" IS
      'Empleado (users.id del espejo) al que se compartió el pedido para alistar (retail). Amplía visibilidad, NO atribución. NULL si no se compartió.'
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_sale_invoices_assigned_to_user_id'
        ) THEN
          ALTER TABLE "sale_invoices"
          ADD CONSTRAINT "fk_sale_invoices_assigned_to_user_id"
          FOREIGN KEY ("assigned_to_user_id") REFERENCES "users" ("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sale_invoices_assigned_to_user_id"
      ON "sale_invoices" ("assigned_to_user_id")
      WHERE assigned_to_user_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "idx_sale_invoices_assigned_to_user_id"');
    await queryRunner.query(
      'ALTER TABLE "sale_invoices" DROP CONSTRAINT IF EXISTS "fk_sale_invoices_assigned_to_user_id"',
    );
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
        DROP COLUMN IF EXISTS "assigned_to_name",
        DROP COLUMN IF EXISTS "assigned_to_user_id"
    `);
  }
}
