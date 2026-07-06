import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Subpermisos del permiso "Ver márgenes y ganancias": controlan de forma
 * granular si el empleado ve el Margen (%) y/o la Ganancia ($) en el
 * configurador de producto del POS (ProductConfigurator). Nacen en false, pero
 * se hace back-fill = can_view_profit para preservar el comportamiento actual
 * (con el permiso principal activo, el configurador mostraba ambos). Paridad con
 * placepos (AddProductProfitSubpermsToEmployees).
 */
export class AddProductProfitSubpermsToEmployees1747012100000 implements MigrationInterface {
  name = 'AddProductProfitSubpermsToEmployees1747012100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'employees',
      new TableColumn({
        name: 'can_view_product_margin',
        type: 'boolean',
        isNullable: false,
        default: false,
        comment: 'Subpermiso: ver el margen (%) del producto en el configurador del POS.',
      }),
    );
    await queryRunner.addColumn(
      'employees',
      new TableColumn({
        name: 'can_view_product_profit',
        type: 'boolean',
        isNullable: false,
        default: false,
        comment: 'Subpermiso: ver la ganancia ($) del producto en el configurador del POS.',
      }),
    );
    // Preserva el comportamiento actual: quien ya veía márgenes/ganancias
    // (can_view_profit) sigue viéndolos en el configurador tras el split.
    await queryRunner.query(
      `UPDATE "employees" SET "can_view_product_margin" = "can_view_profit", "can_view_product_profit" = "can_view_profit"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('employees', 'can_view_product_profit');
    await queryRunner.dropColumn('employees', 'can_view_product_margin');
  }
}
