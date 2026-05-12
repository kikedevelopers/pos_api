import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 5 — Crea la tabla `wallets`.
 *
 * Espejo del contrato PlacePos (`Wallet.ts`) adaptado al modelo multi-tenant.
 *
 * Divergencias intencionales respecto a PlacePos:
 *
 *   - `name` en PlacePos es UNIQUE GLOBAL. Aquí lo hacemos UNIQUE
 *     PER-COMPANY: dos tenants distintos pueden tener cada uno una
 *     wallet llamada "Efectivo" sin colisionar. Mismo principio que
 *     aplicamos en `banks`.
 *
 *   - `company_id` NOT NULL con FK a `companies` (RESTRICT).
 *
 *   - `balance numeric(15,2)` — Money rule CLAUDE.md §2.5. Default 0.
 *
 * Seed de "Efectivo": el `RegisterAction` debería crear una wallet inicial
 * llamada "Efectivo" en la misma transacción del registro. Lo cablea
 * `CreateDefaultWalletAction` exportada por `WalletsModule`. Ver report final.
 */
export class CreateWalletsTable1747008540000 implements MigrationInterface {
  name = 'CreateWalletsTable1747008540000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'wallets',
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
              'Tenant al que pertenece la wallet. Asignado por el service desde req.user.company_id.',
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
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
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
          },
          {
            name: 'created_by',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'created_by_id',
            type: 'bigint',
            isNullable: true,
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
            name: 'chk_wallets_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
          {
            name: 'chk_wallets_balance_not_null',
            expression: 'balance IS NOT NULL',
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'wallets',
      new TableForeignKey({
        name: 'fk_wallets_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índice por company_id.
    await queryRunner.createIndex(
      'wallets',
      new TableIndex({
        name: 'idx_wallets_company_id',
        columnNames: ['company_id'],
      }),
    );

    // Índice parcial activos.
    await queryRunner.query(`
      CREATE INDEX idx_wallets_company_active
      ON wallets (company_id)
      WHERE is_archived = false
    `);

    // UNIQUE per-company sobre name (entre activas). Permite recrear "Efectivo"
    // tras archivar la previa.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_wallets_company_name_unique
      ON wallets (company_id, name)
      WHERE is_archived = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_wallets_company_name_unique');
    await queryRunner.query('DROP INDEX IF EXISTS idx_wallets_company_active');
    await queryRunner.dropIndex('wallets', 'idx_wallets_company_id');
    await queryRunner.dropForeignKey('wallets', 'fk_wallets_company_id');
    await queryRunner.dropTable('wallets');
  }
}
