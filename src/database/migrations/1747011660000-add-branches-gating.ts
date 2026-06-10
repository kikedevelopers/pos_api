import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Gating administrativo de sucursales.
 *
 * --------------------------------------------------------------------------
 * `users` (en el OWNER)
 * --------------------------------------------------------------------------
 *   - `branches_enabled` (bool, default false): el admin habilita las
 *     sucursales de la cuenta bajo pedido. Mientras sea false, el cliente no
 *     puede ver el selector ni crear sucursales.
 *   - `branches_allowed` (int, default 0, CHECK >= 0): cuántas sucursales
 *     puede crear. La regla `enabled ⇒ allowed >= 1` se valida en el DTO/action
 *     (no como CHECK, para tolerar estados intermedios).
 *
 * --------------------------------------------------------------------------
 * `company_members.is_active` (bool, default true)
 * --------------------------------------------------------------------------
 *   Estado activa/suspendida de cada sucursal para su owner. Suspendida = la
 *   fila de membresía existe (datos intactos, reversible) pero no es
 *   seleccionable. El negocio principal (is_branch=false) queda siempre activo.
 *
 * Aditiva: owners existentes quedan enabled=false/allowed=0 (estado seguro: sin
 * sucursales hasta que un admin las habilite); membresías existentes activas.
 */
export class AddBranchesGating1747011660000 implements MigrationInterface {
  name = 'AddBranchesGating1747011660000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'users',
      new TableColumn({
        name: 'branches_enabled',
        type: 'boolean',
        isNullable: false,
        default: false,
        comment: 'El admin habilita las sucursales de esta cuenta (owner).',
      }),
    );

    await queryRunner.addColumn(
      'users',
      new TableColumn({
        name: 'branches_allowed',
        type: 'integer',
        isNullable: false,
        default: 0,
        comment: 'Cantidad de sucursales que el owner puede crear.',
      }),
    );

    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "chk_users_branches_allowed_nonneg" CHECK (branches_allowed >= 0)`,
    );

    await queryRunner.addColumn(
      'company_members',
      new TableColumn({
        name: 'is_active',
        type: 'boolean',
        isNullable: false,
        default: true,
        comment: 'Sucursal activa (seleccionable) vs suspendida (datos intactos).',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('company_members', 'is_active');
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "chk_users_branches_allowed_nonneg"`,
    );
    await queryRunner.dropColumn('users', 'branches_allowed');
    await queryRunner.dropColumn('users', 'branches_enabled');
  }
}
