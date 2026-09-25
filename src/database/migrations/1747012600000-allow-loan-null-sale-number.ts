import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ajusta el CHECK `chk_sale_invoices_sale_number_consistency` para admitir el
 * nuevo tipo `LOAN` con `sale_number` NULL.
 *
 * --------------------------------------------------------------------------
 * Antes
 * --------------------------------------------------------------------------
 *
 *   ticket_type = 'ORDER'
 *   OR (ticket_type = 'SALE' AND sale_number no vacío)
 *
 * --------------------------------------------------------------------------
 * Después
 * --------------------------------------------------------------------------
 *
 *   ticket_type IN ('ORDER', 'LOAN')
 *   OR (ticket_type = 'SALE' AND sale_number no vacío)
 *
 * Un préstamo (`LOAN`) NO es una venta: no genera folio de venta, así que su
 * `sale_number` permanece NULL igual que un pedido (`ORDER`). Solo `SALE`
 * exige `sale_number` poblado.
 *
 * Depende de que el valor `LOAN` ya exista en el enum `ticket_type`
 * (migración 1747012580000, que corre fuera de transacción y commitea el valor
 * antes de que este CHECK lo referencie).
 *
 * El literal `'LOAN'` del CHECK se castea al enum `ticket_type`; como el valor
 * ya está commiteado, la expresión es válida dentro de esta transacción.
 */
export class AllowLoanNullSaleNumber1747012600000 implements MigrationInterface {
  name = 'AllowLoanNullSaleNumber1747012600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
      DROP CONSTRAINT IF EXISTS "chk_sale_invoices_sale_number_consistency"
    `);
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
      ADD CONSTRAINT "chk_sale_invoices_sale_number_consistency"
      CHECK (
        ticket_type IN ('ORDER', 'LOAN')
        OR (ticket_type = 'SALE' AND length(btrim(coalesce(sale_number, ''))) > 0)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restaura el CHECK original (sin LOAN). Requiere que no queden filas LOAN
    // con sale_number NULL, o el ADD CONSTRAINT fallará — esperado en un
    // rollback de esta feature.
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
      DROP CONSTRAINT IF EXISTS "chk_sale_invoices_sale_number_consistency"
    `);
    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
      ADD CONSTRAINT "chk_sale_invoices_sale_number_consistency"
      CHECK (
        ticket_type = 'ORDER'
        OR (ticket_type = 'SALE' AND length(btrim(coalesce(sale_number, ''))) > 0)
      )
    `);
  }
}
