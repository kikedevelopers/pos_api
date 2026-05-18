import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Riesgo 2 — Extender el enum Postgres `movement_concept` con los valores
 * `REFUND` y `SALE_PAYMENT` que PlacePos ya usa.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * El enum cloud actual define:
 *
 *   SALE, PURCHASE, EXPENSE, TRANSFER, INITIAL_BALANCE, ADJUSTMENT,
 *   CREDIT_PAYMENT, CREDIT_NOTE_REFUND.
 *
 * PlacePos también emite movimientos con `REFUND` (devolución pura — distinta
 * de `CREDIT_NOTE_REFUND` que documenta la nota crédito) y `SALE_PAYMENT`
 * (pago individual a una venta, granular vs el agregado `SALE`). Hoy el cloud
 * sustituye estos casos con `ADJUSTMENT` y `CREDIT_PAYMENT`, lo que crea
 * divergencia silenciosa con PlacePos: reportes y reconciliaciones cruzadas
 * no pueden distinguir el origen real del movimiento.
 *
 * Esta migración añade los dos valores faltantes. Los callers existentes NO
 * se tocan en este commit — la semántica de `ADJUSTMENT` para sobrantes de
 * caja sigue siendo correcta, y `CREDIT_PAYMENT` mantiene la convención
 * para abonos a cartera. Los valores nuevos quedan disponibles para
 * features futuras y para migrar callers caso por caso si se confirma que
 * la semántica real es `REFUND` o `SALE_PAYMENT`.
 *
 * --------------------------------------------------------------------------
 * Por qué `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE … ADD VALUE` dentro de una transacción
 * (error 25001 "ALTER TYPE ... ADD cannot run inside a transaction block").
 * TypeORM envuelve la migración en una TX por defecto; declaramos
 * `transaction = false` para que cada `ALTER TYPE` corra autonomously.
 *
 * --------------------------------------------------------------------------
 * `down()` IRREVERSIBLE
 * --------------------------------------------------------------------------
 *
 * Postgres no soporta `DROP VALUE` directo en un enum. Revertir requeriría:
 *
 *   1. Renombrar el enum actual.
 *   2. CREATE TYPE nuevo sin los valores `REFUND` y `SALE_PAYMENT`.
 *   3. UPDATE de todas las tablas que usen el enum (financial_movements y
 *      cualquier otra futura) reasignando filas que contengan los valores
 *      eliminados — pérdida de información semántica.
 *   4. ALTER COLUMN ... TYPE para hacer cast al nuevo enum.
 *   5. DROP TYPE viejo.
 *
 * Esto es destructivo y no debería ejecutarse en producción. PlacePos trata
 * la extensión del enum como evolución natural (forward-only): el down()
 * queda como no-op explícito documentado.
 */
export class ExtendMovementConceptEnum1747010460000 implements MigrationInterface {
  name = 'ExtendMovementConceptEnum1747010460000';

  // `ALTER TYPE ... ADD VALUE` no puede correr dentro de TX.
  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PlacePos: devoluciones genéricas (efectivo entregado al cliente fuera
    // del flujo de nota crédito) — fuente directa, no mediada por documento.
    await queryRunner.query(`ALTER TYPE "movement_concept" ADD VALUE IF NOT EXISTS 'REFUND'`);

    // PlacePos: pago individual a una venta. Distinto de `SALE` (agregado del
    // ticket) y de `CREDIT_PAYMENT` (abono a cartera).
    await queryRunner.query(`ALTER TYPE "movement_concept" ADD VALUE IF NOT EXISTS 'SALE_PAYMENT'`);
  }

  public async down(): Promise<void> {
    // Irreversible — ver JSDoc. No-op intencional.
    //
    // Si alguien REALMENTE necesita revertir esto:
    //   1. Verificar que no hay filas con concept IN ('REFUND', 'SALE_PAYMENT'):
    //        SELECT count(*) FROM financial_movements
    //        WHERE concept IN ('REFUND', 'SALE_PAYMENT');
    //   2. Renombrar el enum, recrearlo sin esos valores, recastear la
    //      columna y droppear el enum viejo (patrón de
    //      `1747010160000-extend-cash-register-log-type-enum`).
  }
}
