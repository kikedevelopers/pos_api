import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FASE 5 (AJUSTES DE ROLES DE FÁBRICA) — añade `roles.is_editable`.
 *
 * Columna booleana NOT NULL DEFAULT true: indica si un rol se puede
 * editar/eliminar. Todo rol existente (Cajero, roles custom) queda editable por
 * el DEFAULT; el rol de fábrica 'Administrador' se vuelve INMUTABLE
 * (`is_editable = false`) en la migración de datos siguiente
 * (`FinalizeFactoryRoles`). Companies/sucursales nuevas la setean en el seed
 * (`seedSystemRolesForCompany`).
 *
 * Aditiva e idempotente (`ADD COLUMN IF NOT EXISTS`). El `down` la elimina.
 */
export class AddIsEditableToRoles1747011900000 implements MigrationInterface {
  name = 'AddIsEditableToRoles1747011900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "roles"
      ADD COLUMN IF NOT EXISTS "is_editable" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN IF EXISTS "is_editable"`);
  }
}
