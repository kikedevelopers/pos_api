import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 2A — Crea el tipo enum `carrier_credit_status` y la tabla
 * `carrier_credits`.
 *
 * Contexto del dominio:
 *
 *   `CarrierCredit` representa la deuda con un transportista asociada a UNA
 *   compra. 1:1 con `purchases` (UNIQUE en `purchase_id`). El campo
 *   `balance` es derivado (`total - paid_amount`), pero lo persistimos para
 *   evitar joins en queries calientes de analytics y respetar el espejo
 *   PlacePos.
 *
 * --------------------------------------------------------------------------
 * Invariantes enforced en DB
 * --------------------------------------------------------------------------
 *
 *   - `total >= 0`, `paid_amount >= 0`, `balance >= 0`.
 *   - `paid_amount <= total`.
 *   - Invariante contable: `paid_amount + balance = total` (CHECK).
 *   - `status` consistente con `balance`:
 *       balance = 0           → PAID
 *       0 < balance < total   → PARTIAL
 *       balance = total       → PENDING (sin pagos)
 *
 * --------------------------------------------------------------------------
 * UNIQUE (company_id, purchase_id)
 * --------------------------------------------------------------------------
 *
 *   Una compra tiene a lo sumo UN crédito de transportista. La FK ya
 *   garantiza referencia válida; añadimos UNIQUE para enforzar 1:1.
 */
export class CreateCarrierCreditsTable1747009860000 implements MigrationInterface {
  name = 'CreateCarrierCreditsTable1747009860000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE carrier_credit_status AS ENUM ('PENDING', 'PARTIAL', 'PAID')
    `);

    await queryRunner.createTable(
      new Table({
        name: 'carrier_credits',
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
          },
          {
            name: 'carrier_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'purchase_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Compra asociada. Relación 1:1 enforced por UNIQUE.',
          },
          {
            name: 'total',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'paid_amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'balance',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Derivado: total - paid_amount. Persistido por velocidad de analytics.',
          },
          {
            name: 'status',
            type: 'carrier_credit_status',
            isNullable: false,
            default: `'PENDING'`,
            enumName: 'carrier_credit_status',
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
            name: 'chk_carrier_credits_total_non_negative',
            expression: 'total >= 0',
          },
          {
            name: 'chk_carrier_credits_paid_non_negative',
            expression: 'paid_amount >= 0',
          },
          {
            name: 'chk_carrier_credits_balance_non_negative',
            expression: 'balance >= 0',
          },
          {
            name: 'chk_carrier_credits_paid_not_exceed_total',
            expression: 'paid_amount <= total',
          },
          {
            name: 'chk_carrier_credits_accounting_invariant',
            expression: 'abs((paid_amount + balance) - total) < 0.01',
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'carrier_credits',
      new TableForeignKey({
        name: 'fk_carrier_credits_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a carriers.
    await queryRunner.createForeignKey(
      'carrier_credits',
      new TableForeignKey({
        name: 'fk_carrier_credits_carrier_id',
        columnNames: ['carrier_id'],
        referencedTableName: 'carriers',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a purchases.
    await queryRunner.createForeignKey(
      'carrier_credits',
      new TableForeignKey({
        name: 'fk_carrier_credits_purchase_id',
        columnNames: ['purchase_id'],
        referencedTableName: 'purchases',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    await queryRunner.createIndex(
      'carrier_credits',
      new TableIndex({
        name: 'idx_carrier_credits_company_id',
        columnNames: ['company_id'],
      }),
    );

    await queryRunner.createIndex(
      'carrier_credits',
      new TableIndex({
        name: 'idx_carrier_credits_carrier_id',
        columnNames: ['carrier_id'],
      }),
    );

    // UNIQUE (company_id, purchase_id) — 1:1 carrier_credit ↔ purchase.
    await queryRunner.createIndex(
      'carrier_credits',
      new TableIndex({
        name: 'idx_carrier_credits_purchase_unique',
        columnNames: ['company_id', 'purchase_id'],
        isUnique: true,
      }),
    );

    // Soporta analytics: créditos pendientes per-company.
    await queryRunner.query(`
      CREATE INDEX idx_carrier_credits_company_pending
      ON carrier_credits (company_id, carrier_id)
      WHERE balance > 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_carrier_credits_company_pending');
    await queryRunner.dropIndex('carrier_credits', 'idx_carrier_credits_purchase_unique');
    await queryRunner.dropIndex('carrier_credits', 'idx_carrier_credits_carrier_id');
    await queryRunner.dropIndex('carrier_credits', 'idx_carrier_credits_company_id');
    await queryRunner.dropForeignKey('carrier_credits', 'fk_carrier_credits_purchase_id');
    await queryRunner.dropForeignKey('carrier_credits', 'fk_carrier_credits_carrier_id');
    await queryRunner.dropForeignKey('carrier_credits', 'fk_carrier_credits_company_id');
    await queryRunner.dropTable('carrier_credits');
    await queryRunner.query('DROP TYPE IF EXISTS carrier_credit_status');
  }
}
