import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pago parcial/total multi-corte de gastos fijos — estado de pago del corte.
 *
 * Contrato: `CONTRACT_fixed_expense_periods_pay.md` §1.
 *
 * --------------------------------------------------------------------------
 * Cambios sobre `fixed_expense_periods`
 * --------------------------------------------------------------------------
 *
 *   - `paid_amount numeric(15,2) NOT NULL DEFAULT 0`: monto acumulado pagado.
 *   - `balance     numeric(15,2) NOT NULL DEFAULT 0`: saldo restante. En filas
 *     nuevas (sync) se setea = amount al crear el corte.
 *   - `status` admite ahora `'PARTIALLY_PAID'` además de `'PENDING'`/`'PAID'`.
 *
 * Invariantes (CHECK):
 *   - `paid_amount >= 0`, `balance >= 0`, `paid_amount + balance = amount`.
 *   - `status='PENDING'`        ⇔ `paid_amount = 0`
 *   - `status='PARTIALLY_PAID'` ⇔ `paid_amount > 0 AND balance > 0`
 *   - `status='PAID'`           ⇔ `balance = 0`
 *
 * --------------------------------------------------------------------------
 * Backfill (filas existentes)
 * --------------------------------------------------------------------------
 *
 *   - `paid_amount = (status='PAID' ? amount : 0)`
 *   - `balance     = amount - paid_amount`
 *   - `status` se conserva tal cual (solo había 'PENDING' / 'PAID').
 *
 * El backfill corre ANTES de añadir los CHECK de invariantes para que los datos
 * ya cumplan los predicados al validarlos. La ampliación del CHECK de `status`
 * se hace soltando el viejo y creando el nuevo (Postgres no permite ALTER de un
 * CHECK; hay que DROP + ADD).
 */
export class AddPaymentStateToFixedExpensePeriods1747011620000 implements MigrationInterface {
  name = 'AddPaymentStateToFixedExpensePeriods1747011620000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Columnas nuevas (con default 0 para que el ALTER no falle en filas
    //    existentes; el backfill ajusta los valores reales acto seguido).
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        ADD COLUMN paid_amount numeric(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN balance     numeric(15,2) NOT NULL DEFAULT 0
    `);

    // 2. Backfill: PAID → totalmente pagado; resto → todo en saldo.
    await queryRunner.query(`
      UPDATE fixed_expense_periods
      SET paid_amount = CASE WHEN status = 'PAID' THEN amount ELSE 0 END,
          balance     = CASE WHEN status = 'PAID' THEN 0 ELSE amount END
    `);

    // 3. Ampliar el CHECK de status para incluir 'PARTIALLY_PAID'.
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        DROP CONSTRAINT chk_fixed_expense_periods_status
    `);
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        ADD CONSTRAINT chk_fixed_expense_periods_status
        CHECK (status IN ('PENDING','PARTIALLY_PAID','PAID'))
    `);

    // 4. CHECKs de invariantes de pago.
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        ADD CONSTRAINT chk_fixed_expense_periods_paid_amount_nonneg
        CHECK (paid_amount >= 0)
    `);
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        ADD CONSTRAINT chk_fixed_expense_periods_balance_nonneg
        CHECK (balance >= 0)
    `);
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        ADD CONSTRAINT chk_fixed_expense_periods_paid_plus_balance
        CHECK (paid_amount + balance = amount)
    `);
    // Consistencia status ⇔ (paid_amount, balance).
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        ADD CONSTRAINT chk_fixed_expense_periods_status_consistency
        CHECK (
          (status = 'PENDING'        AND paid_amount = 0)
          OR (status = 'PARTIALLY_PAID' AND paid_amount > 0 AND balance > 0)
          OR (status = 'PAID'           AND balance = 0)
        )
    `);

    // 5. Quitar el default de las columnas: los valores reales los fija siempre
    //    la app (sync setea balance=amount, paid_amount=0). El default 0 solo
    //    sirvió para el ALTER ADD COLUMN sobre filas existentes.
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        ALTER COLUMN paid_amount DROP DEFAULT,
        ALTER COLUMN balance     DROP DEFAULT
    `);

    // 6. Índice parcial para el badge "cortes pendientes" (balance > 0). Sustituye
    //    el filtro por status='PENDING' del feed: ahora un corte PARTIALLY_PAID
    //    también cuenta. Cubre el GROUP BY company_id de fetchPendingStats.
    await queryRunner.query(`
      CREATE INDEX idx_fixed_expense_periods_outstanding
      ON fixed_expense_periods (company_id, fixed_expense_id)
      WHERE balance > 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_fixed_expense_periods_outstanding`);

    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        DROP CONSTRAINT IF EXISTS chk_fixed_expense_periods_status_consistency,
        DROP CONSTRAINT IF EXISTS chk_fixed_expense_periods_paid_plus_balance,
        DROP CONSTRAINT IF EXISTS chk_fixed_expense_periods_balance_nonneg,
        DROP CONSTRAINT IF EXISTS chk_fixed_expense_periods_paid_amount_nonneg
    `);

    // Revertir el CHECK de status a su forma original. Antes de hacerlo, cualquier
    // fila PARTIALLY_PAID violaría el CHECK; degradamos esas filas a PENDING
    // (back-compat: pierden el matiz de "parcial" pero conservan el saldo).
    await queryRunner.query(`
      UPDATE fixed_expense_periods
      SET status = 'PENDING'
      WHERE status = 'PARTIALLY_PAID'
    `);
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        DROP CONSTRAINT chk_fixed_expense_periods_status
    `);
    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        ADD CONSTRAINT chk_fixed_expense_periods_status
        CHECK (status IN ('PENDING','PAID'))
    `);

    await queryRunner.query(`
      ALTER TABLE fixed_expense_periods
        DROP COLUMN IF EXISTS balance,
        DROP COLUMN IF EXISTS paid_amount
    `);
  }
}
