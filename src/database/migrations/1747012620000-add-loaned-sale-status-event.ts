import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historial de estados — añade el valor `LOANED` al enum Postgres NATIVO
 * `sale_status_event_type`.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * El enum `sale_status_event_type` (creado en 1747011980000) cataloga las
 * transiciones de estado de una venta que dibuja la línea de tiempo del
 * TicketViewer. `LOANED` marca la conversión ORDER→LOAN (préstamo de mercancía
 * a un tercero): descontó stock sin mover dinero.
 *
 * --------------------------------------------------------------------------
 * `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE ... ADD VALUE` dentro de una transacción
 * (mismo patrón que 1747012580000). `IF NOT EXISTS` la hace idempotente.
 *
 * --------------------------------------------------------------------------
 * `down()` IRREVERSIBLE
 * --------------------------------------------------------------------------
 *
 * Postgres no soporta `DROP VALUE` directo en un enum. No-op intencional.
 */
export class AddLoanedSaleStatusEvent1747012620000 implements MigrationInterface {
  name = 'AddLoanedSaleStatusEvent1747012620000';

  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "sale_status_event_type" ADD VALUE IF NOT EXISTS 'LOANED'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible — ver JSDoc. No-op intencional.
  }
}
