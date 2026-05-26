import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Módulo Domiciliarios — Añade `DELIVERY_PAYMENT` y `VOID_DELIVERY_PAYMENT` al
 * enum `cash_register_log_type`.
 *
 * --------------------------------------------------------------------------
 * Motivación / decisión de modelado
 * --------------------------------------------------------------------------
 *
 * El feature "Domiciliarios" registra un EGRESO de caja cuando un domicilio se
 * paga `cash_register` (la company le paga al domiciliario desde la caja del
 * cajero) y un INGRESO de reversión cuando ese domicilio se archiva.
 *
 * El enum `cash_register_log_type` no tiene un valor que describa esta
 * semántica de forma idiomática:
 *   - `EXPENSE` / `VOID_EXPENSE` pertenecen al dominio de gastos
 *     administrativos (módulo `expenses`) y mezclarían reportes.
 *   - `CARRIER_PAYMENT` es para pagos a transportistas de COMPRAS (módulo
 *     carrier-payments), un dominio distinto.
 *   - `ADMIN_ADJUSTMENT` es demasiado genérico y perdería la trazabilidad.
 *
 * Por eso se AÑADEN dos valores dedicados, manteniendo el patrón "acción /
 * reversión" del resto del enum (`EXPENSE`/`VOID_EXPENSE`):
 *   - `DELIVERY_PAYMENT`      (OUT) — egreso por domicilio pagado de caja.
 *   - `VOID_DELIVERY_PAYMENT` (IN)  — reversión al anular el domicilio.
 *
 * --------------------------------------------------------------------------
 * `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE … ADD VALUE` dentro de una transacción.
 * Declaramos `transaction = false` para que el `ALTER TYPE` corra de forma
 * autónoma (mismo patrón que 1747010460000, 1747010640000 y 1747010800000).
 *
 * --------------------------------------------------------------------------
 * `down()` IRREVERSIBLE
 * --------------------------------------------------------------------------
 *
 * Postgres no soporta `DROP VALUE` directo en un enum. Revertir requeriría
 * renombrar el enum, recrearlo sin el valor y recastear la columna — es
 * destructivo y no debe ejecutarse en producción. No-op intencional.
 */
export class AddDeliveryCashRegisterLogTypes1747011040000 implements MigrationInterface {
  name = 'AddDeliveryCashRegisterLogTypes1747011040000';

  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "cash_register_log_type" ADD VALUE IF NOT EXISTS 'DELIVERY_PAYMENT'`,
    );
    await queryRunner.query(
      `ALTER TYPE "cash_register_log_type" ADD VALUE IF NOT EXISTS 'VOID_DELIVERY_PAYMENT'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible — ver JSDoc. No-op intencional.
  }
}
