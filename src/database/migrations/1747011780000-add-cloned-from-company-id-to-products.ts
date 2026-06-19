import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SUCURSALES (CLONAR) — añade `products.cloned_from_company_id`.
 *
 * Marca el ORIGEN de un producto en una sucursal:
 *   - `NULL`     → producto PROPIO (creado en esta company) o compartido (el
 *     compartido vive en el principal; su fila no se marca aquí).
 *   - no-null    → COPIA: clonado desde la company indicada (el principal).
 *
 * Permite al front distinguir en la sucursal entre "Propio", "Copia" y
 * "Compartido" (esto último se deriva de `is_shared`, no de esta columna).
 * Informativo; sin FK para no acoplar el borrado de companies a este marcador.
 */
export class AddClonedFromCompanyIdToProducts1747011780000 implements MigrationInterface {
    name = 'AddClonedFromCompanyIdToProducts1747011780000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "cloned_from_company_id" bigint`,
        );
        await queryRunner.query(
            `COMMENT ON COLUMN "products"."cloned_from_company_id" IS 'Si es COPIA (clon), company de origen (el principal). NULL = propio.'`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "products" DROP COLUMN IF EXISTS "cloned_from_company_id"`,
        );
    }
}
