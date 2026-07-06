import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Permiso por-empleado "puede ver el saldo y el historial de caja" en el POS.
 * Default false; al asignar el rol "Cajero" se activa por defecto. Paridad con
 * placepos (AddCanViewCashToEmployees). No requiere backfill: el `default: false`
 * cubre las filas preexistentes.
 */
export class AddCanViewCashToEmployees1747012080000 implements MigrationInterface {
  name = 'AddCanViewCashToEmployees1747012080000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'employees',
      new TableColumn({
        name: 'can_view_cash',
        type: 'boolean',
        isNullable: false,
        default: false,
        comment: 'Permiso del empleado para ver el saldo y el historial de caja en el POS.',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('employees', 'can_view_cash');
  }
}
