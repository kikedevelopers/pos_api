import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Presentaciones de peso/monto variable — Añade `is_auto` a `packagings`.
 *
 * Espejo de la migración local de PlacePos (`AddIsAutoToPackagings`). Un empaque
 * `is_auto = true` es creado por el sistema (find-or-create) cuando una
 * presentación se vende por peso/monto variable: el factor de conversión sigue
 * viviendo en `packaging.value`, así que POS / inventario / compras funcionan
 * sin cambios. La bandera SOLO sirve para excluirlo del SELECTOR de empaques
 * (`GET /packagings`); el usuario nunca lo gestiona.
 *
 * Aditiva y backward-compatible: las filas existentes toman el default `false`.
 */
export class AddIsAutoToPackagings1747011680000 implements MigrationInterface {
  name = 'AddIsAutoToPackagings1747011680000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'packagings',
      new TableColumn({
        name: 'is_auto',
        type: 'boolean',
        isNullable: false,
        default: false,
        comment:
          'Empaque auto del sistema para presentaciones de peso/monto variable. Excluido del selector (GET /packagings); indistinguible para POS/inventario/compras.',
      }),
    );

    // Índice parcial para acelerar el find-or-create por (company_id, value)
    // sobre empaques auto activos (la ruta caliente al crear/editar una
    // presentación variable).
    await queryRunner.query(`
      CREATE INDEX idx_packagings_company_auto_value
      ON packagings (company_id, value)
      WHERE is_auto = true AND is_archived = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_packagings_company_auto_value`);
    await queryRunner.dropColumn('packagings', 'is_auto');
  }
}
