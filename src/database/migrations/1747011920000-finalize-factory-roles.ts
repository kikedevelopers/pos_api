import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FASE 5 (AJUSTES DE ROLES DE FÁBRICA) — migración de DATOS, todas las
 * companies. Idempotente.
 *
 * Decisiones del owner:
 *   - Los roles de fábrica son SOLO 2: 'Administrador' y 'Cajero'.
 *   - 'Administrador' es INMUTABLE: `is_editable = false` (acceso total que ni
 *     el owner puede editar/eliminar).
 *   - 'Inventarista' se ELIMINA.
 *
 * Pasos (ambos idempotentes; reejecutar no rompe):
 *   1. Marca como NO editable el rol de sistema 'Administrador' de cada company
 *      (case/trim-insensitive). El resto de roles ya quedó editable por el
 *      DEFAULT true de la columna.
 *   2. Borra el rol de sistema 'Inventarista' SÓLO si NO tiene empleados
 *      asignados (FK `employees.role_id`). Si alguna company lo tuviera en uso,
 *      se deja intacto y la migración NO falla (el owner deberá reasignar esos
 *      empleados manualmente antes de poder eliminarlo).
 *
 * `down` revierte el flag de 'Administrador' a editable (best-effort). NO
 * recrea 'Inventarista': el borrado de datos es irreversible por diseño (no se
 * puede reconstruir a qué empleados estaba asignado). Migración de datos: el
 * down es de mejor esfuerzo.
 */
export class FinalizeFactoryRoles1747011920000 implements MigrationInterface {
  name = 'FinalizeFactoryRoles1747011920000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 'Administrador' (rol de sistema) → inmutable.
    await queryRunner.query(`
      UPDATE roles
      SET is_editable = false
      WHERE is_system = true
        AND lower(btrim(name)) = 'administrador'
        AND is_editable = true
    `);

    // 2. Eliminar 'Inventarista' (rol de sistema) SÓLO sin empleados asignados.
    await queryRunner.query(`
      DELETE FROM roles r
      WHERE r.is_system = true
        AND lower(btrim(r.name)) = 'inventarista'
        AND NOT EXISTS (
          SELECT 1 FROM employees e WHERE e.role_id = r.id
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revierte sólo el flag de 'Administrador' (best-effort). 'Inventarista' no
    // se recrea: el borrado de datos es irreversible por diseño.
    await queryRunner.query(`
      UPDATE roles
      SET is_editable = true
      WHERE is_system = true
        AND lower(btrim(name)) = 'administrador'
    `);
  }
}
