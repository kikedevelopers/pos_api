import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade el valor `MANUAL` al enum `product_cost_history_source`
 * (derived_from). Permite registrar la edición directa del costo de un producto
 * desde el formulario (event EDIT, derived_from MANUAL). Paridad con placepos,
 * cuya columna es varchar y no requiere migración.
 *
 * `ADD VALUE IF NOT EXISTS` es idempotente. En Postgres 12+ puede ejecutarse
 * dentro de una transacción siempre que el valor no se USE en la misma tx
 * (aquí solo se añade). No hay `down`: Postgres no soporta quitar valores de un
 * enum sin recrear el tipo.
 */
export class AddManualToCostHistorySource1747012040000 implements MigrationInterface {
  name = 'AddManualToCostHistorySource1747012040000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "product_cost_history_source" ADD VALUE IF NOT EXISTS 'MANUAL'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres no permite eliminar un valor de un enum; no-op.
  }
}
