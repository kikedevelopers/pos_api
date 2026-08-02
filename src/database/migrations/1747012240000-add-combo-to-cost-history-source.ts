import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Añade el valor `COMBO` al enum `product_cost_history_source` (`derived_from`).
 *
 * El costo de un producto COMBO es DERIVADO de sus componentes: cuando cambia
 * el costo de un base que forma parte de una receta (compra recibida o edición
 * manual), el combo se recalcula y deja su fila de auditoría con
 * `event EDIT/RECEIVE` + `derived_from COMBO`. Paridad con placepos, cuya
 * columna es varchar y no requiere migración.
 *
 * `ADD VALUE IF NOT EXISTS` es idempotente. No hay `down`: Postgres no soporta
 * quitar valores de un enum sin recrear el tipo.
 */
export class AddComboToCostHistorySource1747012240000 implements MigrationInterface {
  name = 'AddComboToCostHistorySource1747012240000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "product_cost_history_source" ADD VALUE IF NOT EXISTS 'COMBO'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres no permite eliminar un valor de un enum; no-op.
  }
}
