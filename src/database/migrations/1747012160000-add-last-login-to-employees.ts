import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Añade `employees.last_login` (timestamptz, nullable). Registra el último
 * login exitoso del empleado. NULL = nunca se ha conectado (distinguible de una
 * fecha real). Se sella en `LoginAction` (path employee) y lo exponen la lista
 * y el detalle de empleados. Paridad PlacePos (`AddLastLoginToEmployees`).
 */
export class AddLastLoginToEmployees1747012160000 implements MigrationInterface {
  name = 'AddLastLoginToEmployees1747012160000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'employees',
      new TableColumn({
        name: 'last_login',
        type: 'timestamptz',
        isNullable: true,
        comment: 'Fecha/hora del último login exitoso del empleado.',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('employees', 'last_login');
  }
}
