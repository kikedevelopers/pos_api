import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Permiso por-empleado "puede cobrar pedidos" (ORDER→SALE) en el POS.
 *
 * Default false: actúa como OVERRIDE solo para roles NO elevados (p. ej.
 * Vendedor). La capacidad efectiva se calcula en runtime como
 * `owner/superadmin || rol concede canViewAllSales || can_charge_orders`, por lo
 * que los roles elevados (Cajero/Administrador) pueden cobrar aunque el flag
 * esté en false — no requiere backfill. Un admin lo activa para un vendedor
 * puntual desde el detalle del empleado (`PUT /employees/:id/charge-permission`).
 */
export class AddCanChargeOrdersToEmployees1747012800000 implements MigrationInterface {
  name = 'AddCanChargeOrdersToEmployees1747012800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'employees',
      new TableColumn({
        name: 'can_charge_orders',
        type: 'boolean',
        isNullable: false,
        default: false,
        comment: 'Permiso del empleado para cobrar pedidos (ORDER→SALE) en el POS.',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('employees', 'can_charge_orders');
  }
}
