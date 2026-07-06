import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Añade `users.last_login` (timestamptz, nullable). Registra el último login
 * exitoso del usuario (owner/superadmin). NULL para usuarios que aún no han
 * iniciado sesión desde que existe la columna. Lo expone el detalle de tenant
 * del superadmin (kdevs-admin).
 */
export class AddLastLoginToUsers1747012060000 implements MigrationInterface {
  name = 'AddLastLoginToUsers1747012060000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'users',
      new TableColumn({
        name: 'last_login',
        type: 'timestamptz',
        isNullable: true,
        comment: 'Fecha/hora del último login exitoso del usuario.',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('users', 'last_login');
  }
}
