import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Permiso por-empleado "puede ver márgenes y ganancias". Default false: los
 * empleados existentes quedan sin acceso hasta que un administrador lo habilite
 * desde el detalle del empleado. Paridad con placepos
 * (AddCanViewProfitToEmployees). No requiere backfill: el `default: false`
 * cubre las filas preexistentes.
 */
export class AddCanViewProfitToEmployees1747012020000 implements MigrationInterface {
  name = 'AddCanViewProfitToEmployees1747012020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'employees',
      new TableColumn({
        name: 'can_view_profit',
        type: 'boolean',
        isNullable: false,
        default: false,
        comment: 'Permiso del empleado para ver márgenes y ganancias. Solo lo cambia un admin.',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('employees', 'can_view_profit');
  }
}
