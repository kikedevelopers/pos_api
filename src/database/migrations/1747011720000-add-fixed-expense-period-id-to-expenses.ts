import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Enlaza cada gasto materializado por un abono de gasto fijo con su corte
 * (`fixed_expense_periods`) — Añade `fixed_expense_period_id` a `expenses`.
 *
 * Espejo de la migración local de PlacePos (`AddFixedExpensePeriodIdToExpenses`).
 * Permite el bloque "ABONOS A GASTOS FIJOS" del cierre diario (monto total del
 * corte, saldo y vencimiento), que el enlace inverso
 * `fixed_expense_periods.expense_id` no puede dar de forma fiable (solo apunta al
 * ÚLTIMO abono del corte). Nullable: los gastos variables y los abonos previos a
 * esta columna quedan en NULL.
 *
 * Backfill best-effort: enlaza los gastos referenciados por `period.expense_id`
 * (último abono de cada corte). Los abonos parciales intermedios históricos
 * quedan sin enlazar; de aquí en adelante TODOS los abonos se enlazan al crearse.
 */
export class AddFixedExpensePeriodIdToExpenses1747011720000 implements MigrationInterface {
  name = 'AddFixedExpensePeriodIdToExpenses1747011720000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'expenses',
      new TableColumn({
        name: 'fixed_expense_period_id',
        type: 'bigint',
        isNullable: true,
        comment:
          'Corte (fixed_expense_periods) al que pertenece este abono cuando is_fixed = true. Permite reconstruir total/saldo/vencimiento del corte en el cierre diario. NULL en gastos variables.',
      }),
    );

    await queryRunner.query(`
      UPDATE expenses e
      SET fixed_expense_period_id = p.id
      FROM fixed_expense_periods p
      WHERE p.expense_id = e.id
        AND e.fixed_expense_period_id IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('expenses', 'fixed_expense_period_id');
  }
}
