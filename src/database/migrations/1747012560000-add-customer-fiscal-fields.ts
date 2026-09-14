import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Identidad fiscal del CLIENTE (adquirente) para Facturación Electrónica.
 *
 * Estos campos son los que APIDIAN exige en el objeto `customer` del payload de
 * factura (ver `InvoiceRequest.php`): tipo de documento, dígito de verificación,
 * régimen, responsabilidad tributaria, municipio y matrícula mercantil. NO se
 * crean catálogos en pos_api: los ids referencian los catálogos que viven en el
 * API externo (APIDIAN) — la fuente de la verdad de la DIAN. Aquí solo se GUARDA
 * la elección del usuario (regla del proyecto: pos_api solo config+datos+gate).
 *
 * `type_organization_id` NO se persiste: se deriva de `person_type`
 * (INDIVIDUAL → Persona Natural, COMPANY → Persona Jurídica) al armar el payload,
 * para no duplicar información que ya vive en la columna existente.
 *
 * Todas las columnas son NULL: la FE es cloud-only y opt-in; los clientes
 * existentes y los negocios sin FE quedan intactos sin backfill.
 */
export class AddCustomerFiscalFields1747012560000 implements MigrationInterface {
  name = 'AddCustomerFiscalFields1747012560000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "customers"
        ADD COLUMN IF NOT EXISTS "type_document_identification_id" integer,
        ADD COLUMN IF NOT EXISTS "dv" varchar(1),
        ADD COLUMN IF NOT EXISTS "type_regime_id" integer,
        ADD COLUMN IF NOT EXISTS "type_liability_id" integer,
        ADD COLUMN IF NOT EXISTS "municipality_id" integer,
        ADD COLUMN IF NOT EXISTS "merchant_registration" text
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "customers"."type_document_identification_id" IS
      'Ref al catálogo type_document_identifications de APIDIAN (CC, NIT, CE…). NULL si el negocio no factura electrónicamente.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "customers"."dv" IS
      'Dígito de verificación DIAN (solo para NIT). Se calcula desde el número de documento.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "customers"."type_regime_id" IS
      'Ref al catálogo type_regimes de APIDIAN (Responsable / No responsable de IVA).'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "customers"."type_liability_id" IS
      'Ref al catálogo type_liabilities de APIDIAN (responsabilidad tributaria).'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "customers"."municipality_id" IS
      'Ref al catálogo municipalities de APIDIAN (municipio del adquirente).'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "customers"."merchant_registration" IS
      'Matrícula mercantil del adquirente (texto libre, opcional).'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "customers"
        DROP COLUMN IF EXISTS "type_document_identification_id",
        DROP COLUMN IF EXISTS "dv",
        DROP COLUMN IF EXISTS "type_regime_id",
        DROP COLUMN IF EXISTS "type_liability_id",
        DROP COLUMN IF EXISTS "municipality_id",
        DROP COLUMN IF EXISTS "merchant_registration"
    `);
  }
}
