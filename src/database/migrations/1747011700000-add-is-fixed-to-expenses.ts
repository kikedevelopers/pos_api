import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Distingue los gastos de origen FIJO dentro de `expenses` — Añade `is_fixed`.
 *
 * Espejo de la migración local de PlacePos (`AddIsFixedToExpenses`). Al pagar un
 * corte de un gasto fijo se materializa una fila en `expenses` (igual que un
 * gasto variable) y se debita la fuente. El problema: esa fila se sumaba a los
 * "Gastos del día" que se restan de la ganancia, mientras el débito a la caja
 * YA bajó el saldo → el gasto fijo restaba dos veces.
 *
 * Regla de negocio: SOLO los gastos VARIABLES restan de la ganancia del día.
 * Los gastos fijos únicamente bajan el saldo de la fuente de donde salieron.
 * `is_fixed = true` marca las filas de origen fijo para excluirlas de TODA
 * lectura de "gastos" (agregados de ganancia, gráficas y el listado de gastos),
 * dejándolas visibles solo en el módulo de Gastos Fijos.
 *
 * Aditiva y backward-compatible: las filas existentes toman el default `false`;
 * el backfill marca las históricas materializadas por el pago de gastos fijos,
 * identificables por el prefijo determinista de su `description`.
 */
export class AddIsFixedToExpenses1747011700000 implements MigrationInterface {
  name = 'AddIsFixedToExpenses1747011700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'expenses',
      new TableColumn({
        name: 'is_fixed',
        type: 'boolean',
        isNullable: false,
        default: false,
        comment:
          'true = gasto materializado por el pago de un gasto FIJO. Excluido de los "gastos del día" que restan de la ganancia y del listado de gastos; visible solo en el módulo de Gastos Fijos.',
      }),
    );

    // Backfill: las filas materializadas por el pago de gastos fijos usan un
    // `description` determinista ("Gasto fijo: <name> — periodo <n>"), único
    // punto de materialización en `PayFixedExpensePeriodsAction`.
    await queryRunner.query(`
      UPDATE expenses
      SET is_fixed = true
      WHERE description LIKE 'Gasto fijo:%'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('expenses', 'is_fixed');
  }
}
