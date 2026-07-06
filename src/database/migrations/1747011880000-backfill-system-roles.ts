import type { MigrationInterface, QueryRunner } from 'typeorm';

import { seedSystemRolesForCompany } from '@/modules/roles/internal/system-roles';

/**
 * FASE 1 (ROLES Y PERMISOS) — back-fill de roles de fábrica.
 *
 * Siembra los roles de sistema de fábrica para TODAS las companies existentes
 * que aún no los tengan. (En FASE 1 eran 3 —Administrador, Cajero,
 * Inventarista—; FASE 5 los redujo a 2 y eliminó Inventarista vía
 * `FinalizeFactoryRoles`.) Companies nuevas los
 * reciben en `RegisterAction`; esta migración cubre las preexistentes.
 *
 * Reutiliza `seedSystemRolesForCompany` (misma maquinaria que el register), que
 * es IDEMPOTENTE: corre con SQL crudo, lee los nombres ya presentes y sólo
 * inserta los faltantes. Correr la migración no rompe si una company ya tenía
 * (parte de) sus roles.
 *
 * `down` borra ÚNICAMENTE los roles de sistema (`is_system = true`) que no
 * tengan empleados asignados, para no violar la FK `employees.role_id`
 * (ON DELETE SET NULL desasignaría empleados silenciosamente; preferimos no
 * tocar roles en uso). Es un back-fill: el down es best-effort.
 *
 * NOTA (fix de ordenamiento): `seedSystemRolesForCompany` es código VIVO que
 * evolucionó e inserta `roles.is_editable`, columna que sólo agrega la migración
 * POSTERIOR `AddIsEditableToRoles1747011900000`. En una BD que corre la cadena
 * de golpe desde un estado viejo (p.ej. producción) el seed falla aquí con
 * "column is_editable does not exist". Para hacer la migración self-contained
 * garantizamos la columna ANTES de sembrar, con el MISMO DDL idempotente que la
 * migración posterior (que luego queda no-op por su `ADD COLUMN IF NOT EXISTS`).
 * Es inocuo en BDs donde esta migración ya se aplicó (registrada por nombre).
 */
export class BackfillSystemRoles1747011880000 implements MigrationInterface {
  name = 'BackfillSystemRoles1747011880000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Garantiza `roles.is_editable` antes del seed (ver NOTA de cabecera).
    // Idéntico e idempotente respecto a AddIsEditableToRoles1747011900000.
    await queryRunner.query(`
      ALTER TABLE "roles"
      ADD COLUMN IF NOT EXISTS "is_editable" boolean NOT NULL DEFAULT true
    `);

    const companies = (await queryRunner.query(`SELECT id FROM companies`)) as Array<{
      id: string;
    }>;

    for (const company of companies) {
      await seedSystemRolesForCompany(queryRunner.manager, company.id);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Borra sólo roles de sistema sin empleados asociados (best-effort).
    await queryRunner.query(`
      DELETE FROM roles r
      WHERE r.is_system = true
        AND NOT EXISTS (
          SELECT 1 FROM employees e WHERE e.role_id = r.id
        )
    `);
  }
}
