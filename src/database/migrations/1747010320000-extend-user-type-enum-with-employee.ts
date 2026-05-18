import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 4A — Extiende el enum `user_type` con el valor `'employee'` para
 * soportar el patrón **User-espejo de Employee** (ver
 * `1747010340000-add-user-id-to-employees.ts`).
 *
 * --------------------------------------------------------------------------
 * Por qué un enum value nuevo
 * --------------------------------------------------------------------------
 *
 * Un Employee con `login_enabled=true` tiene un User espejo en `users` que
 * representa su identidad para los modelos atados a `users.id`
 * (cash_register, cash_register_log, financial_movement). Para distinguir
 * estos espejos del owner real, su `type` es `'employee'` (literal, paridad
 * PlacePos).
 *
 * Antes de Fase 4A, `user_type` solo aceptaba `('superadmin', 'owner')`.
 *
 * --------------------------------------------------------------------------
 * CHECK constraint en `users`
 * --------------------------------------------------------------------------
 *
 * La migración `1747008060000-create-users-table.ts` declaró el CHECK:
 *
 *     (type = 'superadmin' AND company_id IS NULL)
 *  OR (type = 'owner'      AND company_id IS NOT NULL)
 *
 * Con la nueva categoría `'employee'` debemos ampliar el CHECK para admitir
 * `type = 'employee' AND company_id IS NOT NULL`. Drop + recrear es la vía
 * estándar en Postgres (no se puede ALTER CONSTRAINT con cambio de
 * expresión).
 *
 * --------------------------------------------------------------------------
 * Orden con `add-user-id-to-employees`
 * --------------------------------------------------------------------------
 *
 * Esta migración (timestamp 1747010320000) corre ANTES de
 * `1747010340000-add-user-id-to-employees`. El motivo: el helper
 * `ensureMirrorUserForEmployee` solo se invocará después de que ambas
 * migraciones hayan corrido, pero para evitar `pnpm migration:run` parcial
 * dejando la DB en estado inconsistente, ordenamos las dos migraciones
 * adyacentes y se aplican juntas.
 */
export class ExtendUserTypeEnumWithEmployee1747010320000 implements MigrationInterface {
  name = 'ExtendUserTypeEnumWithEmployee1747010320000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Añadir el valor 'employee' al enum.
    //    `IF NOT EXISTS` por idempotencia.
    await queryRunner.query(`ALTER TYPE "user_type" ADD VALUE IF NOT EXISTS 'employee'`);

    // 2. Reemplazar el CHECK existente para que admita type='employee'.
    //    Drop + recrear es la única forma de cambiar la expresión.
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "chk_users_type_company_consistency"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users"
       ADD CONSTRAINT "chk_users_type_company_consistency" CHECK (
         (type = 'superadmin' AND company_id IS NULL)
         OR (type = 'owner'    AND company_id IS NOT NULL)
         OR (type = 'employee' AND company_id IS NOT NULL)
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restaurar el CHECK original (solo superadmin/owner).
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "chk_users_type_company_consistency"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users"
       ADD CONSTRAINT "chk_users_type_company_consistency" CHECK (
         (type = 'superadmin' AND company_id IS NULL)
         OR (type = 'owner'    AND company_id IS NOT NULL)
       )`,
    );

    // NOTA: Postgres NO permite eliminar valores de un enum nativo. El valor
    // 'employee' permanece en el catálogo, pero el CHECK constraint
    // restaurado lo rechazará en cualquier INSERT. Aceptable: un down de
    // migración no garantiza paridad bit-perfect con el estado pre-up,
    // solo desbloquea la regresión funcional.
  }
}
