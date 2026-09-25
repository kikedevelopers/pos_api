import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Préstamo de mercancía a un tercero — añade el valor `LOAN` al enum Postgres
 * NATIVO `ticket_type`.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * El enum `ticket_type` (creado en 1747009260000 con `ORDER | SALE`) rotula la
 * cabecera de `sale_invoices`. El nuevo tipo `LOAN` marca las facturas que son
 * un préstamo de mercancía a un tercero: descuentan stock igual que una venta
 * pero NO mueven dinero y quedan excluidas de todos los informes de venta.
 *
 * --------------------------------------------------------------------------
 * `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE ... ADD VALUE` dentro de una transacción.
 * Declaramos `transaction = false` (mismo patrón que
 * 1747012140000-add-advance-payment-method-enum-value). `migrationsTransactionMode:
 * 'each'` (ver data-source.ts) respeta esta bandera y corre esta migración
 * fuera de TX; así el valor queda COMMITEADO antes de que la migración
 * 1747012600000 lo referencie en el nuevo CHECK.
 *
 * `IF NOT EXISTS` la hace idempotente: re-ejecutarla (o correrla sobre una BD
 * que ya tenga el valor) es no-op.
 *
 * --------------------------------------------------------------------------
 * `down()` IRREVERSIBLE
 * --------------------------------------------------------------------------
 *
 * Postgres no soporta `DROP VALUE` directo en un enum. No-op intencional.
 */
export class AddLoanTicketTypeEnumValue1747012580000 implements MigrationInterface {
  name = 'AddLoanTicketTypeEnumValue1747012580000';

  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "ticket_type" ADD VALUE IF NOT EXISTS 'LOAN'`);
  }

  public async down(): Promise<void> {
    // Irreversible — ver JSDoc. No-op intencional.
  }
}
