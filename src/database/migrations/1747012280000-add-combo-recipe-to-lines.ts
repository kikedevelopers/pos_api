import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * FIX #3 (snapshot de receta de combo) — Añade la columna `combo_recipe` a
 * `sale_invoice_lines` y `credit_note_lines`.
 *
 * --------------------------------------------------------------------------
 * Motivación / decisión de modelado
 * --------------------------------------------------------------------------
 *
 * Hermana exacta de FIX #2 (`packaging_value`). Un combo no tiene stock propio:
 * al comprometer unidades, `adjustInventory` lo EXPLOTA en su receta y descuenta
 * de los componentes. Si esa explosión no queda congelada en la línea, el
 * `RETURN` (anulación / NC) vuelve a leer `combo_components` y usa la receta
 * VIGENTE, no la que se aplicó al vender:
 *
 *   - quitar un componente  → su stock NUNCA vuelve (pérdida permanente);
 *   - subir una cantidad    → devuelve más de lo descontado (stock fantasma);
 *   - añadir un componente  → aparece stock que nunca se descontó.
 *
 * Todo en silencio, igual que pasaba con el `value` del empaque antes de FIX #2.
 *
 *   - `combo_recipe jsonb` — array `[{ component_product_id, quantity }]` con la
 *     cantidad en la unidad MÍNIMA del componente (la misma en la que viaja
 *     `combo_components.quantity`). jsonb y no una tabla hija porque el dato es
 *     un snapshot inmutable que solo se lee entero, junto a su línea.
 *   - `NULL` permitido y SIN backfill: las filas existentes (legacy) quedan en
 *     `null` y el motor cae a la receta vigente — exactamente lo que hacen hoy.
 *     Un array VACÍO sí es significativo: "no tenía componentes al vender".
 *
 * Aditiva y backward-compatible. `synchronize:false` — la columna se crea
 * exclusivamente aquí.
 */
export class AddComboRecipeToLines1747012280000 implements MigrationInterface {
  name = 'AddComboRecipeToLines1747012280000';

  private column(): TableColumn {
    return new TableColumn({
      name: 'combo_recipe',
      type: 'jsonb',
      isNullable: true,
      comment:
        'Snapshot de la receta del combo [{component_product_id, quantity}] congelada al comprometer las unidades. NULL = legacy o línea que no vende un combo (el motor usa la receta vigente).',
    });
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn('sale_invoice_lines', this.column());
    await queryRunner.addColumn('credit_note_lines', this.column());
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('credit_note_lines', 'combo_recipe');
    await queryRunner.dropColumn('sale_invoice_lines', 'combo_recipe');
  }
}
