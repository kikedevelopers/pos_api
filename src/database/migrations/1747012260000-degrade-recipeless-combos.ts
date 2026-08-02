import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Degrada a SIMPLE los productos marcados como COMBO que NO tienen receta.
 * Espejo de placepos (`DegradeRecipelessCombos1792500000000`).
 *
 * POR QUÉ: el valor `COMBO` del enum `product_type` existe desde
 * `create-products-table` y era persistible mucho antes de que hubiera recetas.
 * El motor de inventario lo ignoraba por completo (nunca leía `product_type`),
 * así que esas filas se comportaban como un producto simple: descontaban de su
 * propio stock. En las BD reales hay cientos de filas así, marcadas por
 * importaciones antiguas — productos ordinarios, no combos.
 *
 * Con la llegada de `combo_components`, un COMBO sin receta pasaría a:
 *   - venderse SIN descontar nada (la expansión devuelve cero líneas),
 *   - aparecer siempre agotado (su stock es derivado),
 *   - desaparecer de la valorización del inventario.
 *
 * Todo ello en silencio. Esta migración los devuelve a `SIMPLE`, que es el
 * comportamiento que YA tenían.
 *
 * Multi-tenant: aplica a TODAS las companies — es una corrección de datos
 * transversal, no una operación de tenant. Idempotente: solo toca filas sin
 * ninguna fila en `combo_components`, así que un combo real (que siempre nace
 * con ≥1 componente) nunca se ve afectado.
 *
 * Sin `down()`: revertirla reintroduciría el estado inconsistente.
 */
export class DegradeRecipelessCombos1747012260000 implements MigrationInterface {
  name = 'DegradeRecipelessCombos1747012260000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "products" p
      SET "product_type" = 'SIMPLE'
      WHERE p."product_type" = 'COMBO'
        AND NOT EXISTS (
            SELECT 1 FROM "combo_components" cc
            WHERE cc."combo_product_id" = p."id"
              AND cc."company_id" = p."company_id"
        )
    `);
  }

  public async down(): Promise<void> {
    // Irreversible a propósito: volver a marcar esos productos como COMBO los
    // dejaría vendiéndose sin descontar inventario.
  }
}
