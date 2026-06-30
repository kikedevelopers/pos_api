import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * FIX #2 (snapshot de packaging) — Añade la columna `packaging_value` a
 * `sale_invoice_lines` y `credit_note_lines`.
 *
 * --------------------------------------------------------------------------
 * Motivación / decisión de modelado
 * --------------------------------------------------------------------------
 *
 * Toda línea que dispara un ajuste de inventario debe llevar CONGELADO el
 * factor de conversión del empaque (`packagings.value`) con el que las
 * unidades se comprometieron. El motor (`adjustInventory`) usa el snapshot de
 * la línea; si es `null` cae al packaging vigente del producto (fallback
 * legacy, comportamiento actual). Así el `DEDUCT` al cobrar y su `RETURN`
 * posterior (anulación / NC) usan el MISMO factor aunque alguien edite el
 * `value` del empaque entre cobro y devolución (simetría → no corrompe stock).
 *
 *   - `packaging_value numeric(15,4)` — misma precisión que `quantity` /
 *     `packagings.value` (cantidades = numeric(15,4)).
 *   - `NULL` permitido y SIN backfill: las filas existentes (legacy) quedan en
 *     `null` y el motor resuelve con el packaging vigente del producto.
 *
 * Aditiva y backward-compatible. `synchronize:false` — la columna se crea
 * exclusivamente aquí.
 */
export class AddPackagingValueToLines1747011940000 implements MigrationInterface {
  name = 'AddPackagingValueToLines1747011940000';

  private column(): TableColumn {
    return new TableColumn({
      name: 'packaging_value',
      type: 'numeric',
      precision: 15,
      scale: 4,
      isNullable: true,
      comment:
        'Snapshot del factor de conversión del empaque (packagings.value) congelado al comprometer las unidades. NULL = legacy (el motor usa el packaging vigente del producto).',
    });
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn('sale_invoice_lines', this.column());
    await queryRunner.addColumn('credit_note_lines', this.column());
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('credit_note_lines', 'packaging_value');
    await queryRunner.dropColumn('sale_invoice_lines', 'packaging_value');
  }
}
