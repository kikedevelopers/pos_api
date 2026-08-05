import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Permite ELIMINAR un nivel de precio (`product_prices`) sin tocar el
 * histórico, desacoplando el catálogo de los registros ya emitidos.
 *
 * --------------------------------------------------------------------------
 * El problema
 * --------------------------------------------------------------------------
 *
 * Dos FKs apuntan a `product_prices` con `ON DELETE NO ACTION` (RESTRICT
 * diferido):
 *
 *   - `sale_invoice_lines.product_price_id`   → la línea de una venta.
 *   - `product_price_history.product_price_id` → el snapshot de profit/margin
 *     que deja la recepción de una compra.
 *
 * Basta que el producto se haya vendido UNA vez (o entrado por compra) para que
 * el DELETE del nivel reviente con un 23503, que el backend traducía a
 * "No se puede eliminar un nivel de precio que ya tiene ventas o historial de
 * compras asociado". El usuario quedaba atrapado: un precio creado por error
 * era imborrable para siempre.
 *
 * --------------------------------------------------------------------------
 * La decisión de modelado
 * --------------------------------------------------------------------------
 *
 * El histórico NO depende de la fila del catálogo: cada `sale_invoice_lines`
 * guarda su propio SNAPSHOT (`description`, `price`, `cost`, `profit`,
 * `margin`, `price_mode`, `price_position`, `iva_*`) y cada
 * `product_price_history` guarda `sale_price` y el profit/margin antes/después.
 * `product_price_id` es solo un PUNTERO al nivel vigente, no la fuente del dato.
 *
 * Por eso ambas FKs pasan a `ON DELETE SET NULL`: borrar el nivel deja las
 * filas históricas intactas y únicamente vacía el puntero. Ni una venta ni un
 * snapshot se pierden — exactamente el mismo criterio que ya usaba
 * `product_price_history.cost_history_id` (FK nullable con SET NULL).
 *
 * `product_price_history.product_price_id` era NOT NULL, así que se relaja a
 * nullable (`product_id`, denormalizado y NOT NULL, mantiene el snapshot
 * atribuido a su producto).
 *
 * NOTA sobre la cascada de tenant (`EnableTenantCascadeDelete1747011300000`):
 * SET NULL, igual que NO ACTION, no bloquea el barrido de una company — las
 * filas hijas se borran por su propia FK `company_id ON DELETE CASCADE`.
 */
export class AllowPriceLevelDeleteKeepingHistory1747012300000 implements MigrationInterface {
  name = 'AllowPriceLevelDeleteKeepingHistory1747012300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `product_price_history`: el snapshot sobrevive al borrado del nivel.
    await queryRunner.query(
      `ALTER TABLE public.product_price_history ALTER COLUMN product_price_id DROP NOT NULL;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.product_price_history DROP CONSTRAINT IF EXISTS fk_pph_product_price_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.product_price_history ADD CONSTRAINT fk_pph_product_price_id ` +
        `FOREIGN KEY (product_price_id) REFERENCES product_prices(id) ` +
        `ON UPDATE CASCADE ON DELETE SET NULL;`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN public.product_price_history.product_price_id IS ` +
        `'Nivel de precio al que pertenece el snapshot. NULL = el nivel se eliminó del catálogo; el histórico se conserva (ver product_id).';`,
    );

    // `sale_invoice_lines`: la venta conserva su snapshot completo.
    await queryRunner.query(
      `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT IF EXISTS fk_sale_invoice_lines_product_price_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.sale_invoice_lines ADD CONSTRAINT fk_sale_invoice_lines_product_price_id ` +
        `FOREIGN KEY (product_price_id) REFERENCES product_prices(id) ` +
        `ON UPDATE CASCADE ON DELETE SET NULL;`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN public.sale_invoice_lines.product_price_id IS ` +
        `'Nivel de precio aplicado (ej. Detal / Mayor). NULL si fue precio libre o si el nivel se eliminó después; el precio cobrado vive en esta misma línea.';`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT IF EXISTS fk_sale_invoice_lines_product_price_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.sale_invoice_lines ADD CONSTRAINT fk_sale_invoice_lines_product_price_id ` +
        `FOREIGN KEY (product_price_id) REFERENCES product_prices(id) ` +
        `ON UPDATE CASCADE ON DELETE NO ACTION;`,
    );

    await queryRunner.query(
      `ALTER TABLE public.product_price_history DROP CONSTRAINT IF EXISTS fk_pph_product_price_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.product_price_history ADD CONSTRAINT fk_pph_product_price_id ` +
        `FOREIGN KEY (product_price_id) REFERENCES product_prices(id) ` +
        `ON UPDATE CASCADE ON DELETE NO ACTION;`,
    );

    // Volver a NOT NULL solo es posible si nadie borró un nivel mientras la
    // migración estuvo aplicada. Si hay huérfanos, ABORTAMOS en vez de
    // destruirlos: el down nunca debe perder histórico.
    const [{ orphans }] = (await queryRunner.query(
      `SELECT COUNT(*)::int AS orphans FROM public.product_price_history WHERE product_price_id IS NULL;`,
    )) as Array<{ orphans: number }>;

    if (orphans > 0) {
      throw new Error(
        `No se puede revertir: hay ${orphans} filas en product_price_history con product_price_id NULL ` +
          `(niveles de precio eliminados). Restaurar el NOT NULL exigiría borrarlas y eso destruiría histórico.`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE public.product_price_history ALTER COLUMN product_price_id SET NOT NULL;`,
    );
  }
}
