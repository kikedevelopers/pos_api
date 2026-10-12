import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade el TURNO de pedido (`turn_number`, opcional) al `sale_invoice` — módulo
 * restaurante.
 *
 * Cuando la feature "Turnos" está activa, al crear un pedido (ORDER) se le
 * asigna un número de turno cíclico (1..`turnos_max`, reinicia en 1 al superar
 * el tope). Se imprime en un 2º ticket (número grande centrado) y queda fijo en
 * el pedido para reimpresiones.
 *
 * Es OPCIONAL/nullable: retail y los pedidos con turnos apagados quedan en NULL.
 * No hay FK ni índice: es solo un snapshot numérico para mostrar/imprimir.
 */
export class AddTurnNumberToSaleInvoices1747012740000 implements MigrationInterface {
  name = 'AddTurnNumberToSaleInvoices1747012740000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
        ADD COLUMN IF NOT EXISTS "turn_number" integer NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "sale_invoices"."turn_number" IS
      'Turno de pedido (modo restaurante). Contador cíclico 1..turnos_max. NULL si los turnos están apagados o en retail.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
        DROP COLUMN IF EXISTS "turn_number"
    `);
  }
}
