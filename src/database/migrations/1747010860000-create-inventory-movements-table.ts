import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea la tabla `inventory_movements`: log auditable de mutaciones a
 * `products.stock`. Espejo multi-tenant del modelo PlacePos
 * (`placepos/src/main/database/migrations/1789100000000-AddInventoryMovements.ts`).
 *
 * --------------------------------------------------------------------------
 * Por qué multi-tenant
 * --------------------------------------------------------------------------
 *
 * PlacePos opera en mono-tenant: no necesita `company_id`. En cloud cada
 * mutación de stock pertenece a una company; el `company_id` es FK NOT NULL
 * y forma parte del filtro implícito de reportes / auditoría.
 *
 * --------------------------------------------------------------------------
 * Reasons (espejo placepos)
 * --------------------------------------------------------------------------
 *
 *   - `PURCHASE_RECEIVE`   — alta de stock al marcar compra como recibida.
 *   - `PURCHASE_EDIT`      — delta por edición de compra ya recibida.
 *   - `PURCHASE_ARCHIVE`   — reversa de stock al archivar compra recibida.
 *   - `SALE`               — descuento al confirmar venta (ORDER → SALE).
 *   - `SALE_VOID`          — devolución al stock por anulación de venta.
 *   - `SALE_EDIT_CREDIT`   — devolución por NC PARTIAL_VOID en edición.
 *   - `SALE_EDIT_DEBIT`    — descuento por ND ADDITION en edición.
 *   - `MANUAL_ADJUSTMENT`  — ajuste manual desde la UI.
 *   - `BULK_IMPORT`        — import masivo (CSV).
 *   - `INITIAL_LOAD`       — carga inicial / setup.
 *
 * --------------------------------------------------------------------------
 * Direction
 * --------------------------------------------------------------------------
 *
 * `IN` suma al stock, `OUT` lo resta. El monto se persiste SIEMPRE positivo
 * (la columna `quantity` es CHECK > 0). El signo lo lleva `direction`.
 *
 * --------------------------------------------------------------------------
 * Índices
 * --------------------------------------------------------------------------
 *
 *   1. `idx_im_company_product_created` — el reporte natural es
 *      "movimientos del producto X en la company Y entre fechas". Compuesto
 *      por (company_id, product_id, created_at DESC).
 *   2. `idx_im_company_reason_created` — reportes por motivo
 *      (`PURCHASE_RECEIVE` por mes, etc.).
 *   3. `idx_im_company_reference` — lookup por referencia documental
 *      (compra/venta/NC). Parcial: solo cuando `reference_id IS NOT NULL`.
 */
export class CreateInventoryMovementsTable1747010860000 implements MigrationInterface {
  name = 'CreateInventoryMovementsTable1747010860000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_movements (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
        product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        direction VARCHAR(8) NOT NULL CHECK (direction IN ('IN','OUT')),
        quantity NUMERIC(15,4) NOT NULL CHECK (quantity > 0),
        reason VARCHAR(24) NOT NULL CHECK (reason IN (
          'PURCHASE_RECEIVE','PURCHASE_EDIT','PURCHASE_ARCHIVE',
          'SALE','SALE_VOID','SALE_EDIT_CREDIT','SALE_EDIT_DEBIT',
          'MANUAL_ADJUSTMENT','BULK_IMPORT','INITIAL_LOAD'
        )),
        stock_before NUMERIC(15,4) NOT NULL,
        stock_after NUMERIC(15,4) NOT NULL,
        reference_type VARCHAR(24) NULL,
        reference_id BIGINT NULL,
        reference_code VARCHAR(64) NULL,
        description TEXT NULL,
        created_by VARCHAR(255) NULL,
        created_by_id BIGINT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_im_company_product_created
        ON inventory_movements (company_id, product_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_im_company_reason_created
        ON inventory_movements (company_id, reason, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_im_company_reference
        ON inventory_movements (company_id, reference_type, reference_id)
        WHERE reference_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_im_company_reference');
    await queryRunner.query('DROP INDEX IF EXISTS idx_im_company_reason_created');
    await queryRunner.query('DROP INDEX IF EXISTS idx_im_company_product_created');
    await queryRunner.query('DROP TABLE IF EXISTS inventory_movements');
  }
}
