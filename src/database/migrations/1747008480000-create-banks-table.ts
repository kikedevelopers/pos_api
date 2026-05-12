import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 5 — Crea el tipo enum `account_type` y la tabla `banks`.
 *
 * Espejo del contrato PlacePos (`Bank.ts`) adaptado al modelo multi-tenant:
 *
 *   - `company_id` NOT NULL con FK a `companies` (RESTRICT). Toda query lo
 *     filtra. Sin él, el listado `GET /banks` filtraría todas las companies.
 *
 *   - `account_type` enum `('savings' | 'checking')` — mismos valores que
 *     `placepos/src/main/database/enums/AccountType.ts`. enumName en singular
 *     para evitar colisión con la columna del mismo nombre.
 *
 *   - `balance numeric(15,2)` — Money rule CLAUDE.md §2.5. Default 0.
 *
 *   - UNIQUE GLOBAL de PlacePos `(name, account_number)` se reemplaza por
 *     UNIQUE per-company `(company_id, name, account_number) WHERE is_archived = false`.
 *     Razón: el namespace de cuentas bancarias es del negocio, no global.
 *
 *   - `available_in_pos` controla si el banco aparece como método de pago en
 *     el POS. Espeja `payment-banks` endpoint en pos-data.
 *
 *   - Soft-delete: `is_archived` (convención PlacePos §2.4). Filtro implícito
 *     en listados activos. NO se borra físicamente para preservar historial
 *     de pagos / financial_movements que referencien al bank.
 */
export class CreateBanksTable1747008480000 implements MigrationInterface {
  name = 'CreateBanksTable1747008480000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum nativo de Postgres. Coincide con AccountType de PlacePos.
    await queryRunner.query(`
      CREATE TYPE bank_account_type AS ENUM ('savings', 'checking')
    `);

    // 2. Tabla banks.
    await queryRunner.createTable(
      new Table({
        name: 'banks',
        columns: [
          {
            name: 'id',
            type: 'bigserial',
            isPrimary: true,
          },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'Tenant al que pertenece el bank. Asignado por el service desde req.user.company_id; nunca aceptado del payload.',
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'account_number',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'account_type',
            type: 'bank_account_type',
            isNullable: false,
            enumName: 'bank_account_type',
            default: `'savings'`,
          },
          {
            name: 'balance',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'available_in_pos',
            type: 'boolean',
            isNullable: false,
            default: false,
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment: 'Soft-delete convención PlacePos. Filtro implícito en listados activos.',
          },
          {
            name: 'created_by',
            type: 'text',
            isNullable: true,
            comment: 'Snapshot del full_name del usuario que creó el bank.',
          },
          {
            name: 'created_by_id',
            type: 'bigint',
            isNullable: true,
            comment: 'ID del usuario creador. Sin FK formal (informacional).',
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
        checks: [
          {
            name: 'chk_banks_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
          {
            name: 'chk_banks_account_number_not_empty',
            expression: 'length(btrim(account_number)) > 0',
          },
          {
            name: 'chk_banks_balance_not_null',
            expression: 'balance IS NOT NULL',
          },
        ],
      }),
      true,
    );

    // 3. FK a companies. RESTRICT — nunca se borra company con bancos.
    await queryRunner.createForeignKey(
      'banks',
      new TableForeignKey({
        name: 'fk_banks_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. Índice por company_id (FK + filtro caliente).
    await queryRunner.createIndex(
      'banks',
      new TableIndex({
        name: 'idx_banks_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 5. Índice parcial (company_id) WHERE is_archived = false.
    //    Justificación: GET /banks lista solo activos; índice parcial reduce
    //    tamaño excluyendo registros archivados.
    await queryRunner.query(`
      CREATE INDEX idx_banks_company_active
      ON banks (company_id)
      WHERE is_archived = false
    `);

    // 6. UNIQUE parcial (company_id, name, account_number) WHERE is_archived = false.
    //    Replica el UNIQUE GLOBAL de PlacePos pero scoped al tenant. Permite
    //    re-crear un banco con el mismo nombre tras archivar el anterior.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_banks_company_name_account_unique
      ON banks (company_id, name, account_number)
      WHERE is_archived = false
    `);

    // 7. Índice parcial para el endpoint `GET /pos-data/payment-banks`.
    //    Filtra `available_in_pos = true AND is_archived = false`.
    await queryRunner.query(`
      CREATE INDEX idx_banks_company_available_in_pos
      ON banks (company_id)
      WHERE available_in_pos = true AND is_archived = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_banks_company_available_in_pos');
    await queryRunner.query('DROP INDEX IF EXISTS idx_banks_company_name_account_unique');
    await queryRunner.query('DROP INDEX IF EXISTS idx_banks_company_active');
    await queryRunner.dropIndex('banks', 'idx_banks_company_id');
    await queryRunner.dropForeignKey('banks', 'fk_banks_company_id');
    await queryRunner.dropTable('banks');
    await queryRunner.query('DROP TYPE IF EXISTS bank_account_type');
  }
}
