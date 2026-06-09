import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Camino A — Cortes de gastos fijos alineados al calendario.
 *
 * Amplía el CHECK `chk_fixed_expenses_period_unit` para admitir las dos nuevas
 * convenciones de calendario, CONSERVANDO las cuatro unidades legacy
 * (`hour | day | week | month`) sin cambios de comportamiento:
 *
 *   - `'semimonthly'` (Quincenal): dos cortes por mes — día 15 y último día.
 *   - `'end_of_month'` (Mensual): un corte el último día de cada mes.
 *
 * `period_unit` es columna `text`, así que NO hay cambio de tipo ni backfill.
 * Solo se recrea el CHECK constraint. Operación aditiva: los gastos legacy
 * existentes siguen pasando el CHECK sin tocar nada.
 *
 * Reversible: el `down` restablece el CHECK original de 4 valores. OJO: si para
 * entonces existen gastos con `semimonthly`/`end_of_month`, el `down` fallará
 * (intencional — no se debe revertir con datos de calendario vivos).
 */
export class AddCalendarPeriodUnitsToFixedExpenses1747011600000 implements MigrationInterface {
  name = 'AddCalendarPeriodUnitsToFixedExpenses1747011600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "fixed_expenses" DROP CONSTRAINT "chk_fixed_expenses_period_unit"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fixed_expenses" ADD CONSTRAINT "chk_fixed_expenses_period_unit" ` +
        `CHECK (period_unit IN ('hour','day','week','month','semimonthly','end_of_month'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "fixed_expenses" DROP CONSTRAINT "chk_fixed_expenses_period_unit"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fixed_expenses" ADD CONSTRAINT "chk_fixed_expenses_period_unit" ` +
        `CHECK (period_unit IN ('hour','day','week','month'))`,
    );
  }
}
