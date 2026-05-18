import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 2A — Crea el tipo enum `carrier_payment_method` y la tabla
 * `carrier_payments`.
 *
 * Contexto del dominio:
 *
 *   `CarrierPayment` = abono concreto a un `CarrierCredit`. Espejo del
 *   endpoint local `POST /carrier-payments` de PlacePos. Cada pago referencia
 *   también el `financial_movement` que generó (auditoría inmutable) y la
 *   cuenta de origen (bank, wallet, o cash_register a través del FM
 *   marcador).
 *
 * --------------------------------------------------------------------------
 * Validaciones del método de pago
 * --------------------------------------------------------------------------
 *
 *   - `CASH` → `bank_id` y `wallet_id` deben ser NULL. La fuente real es la
 *     caja abierta del usuario logueado (resuelta en el service).
 *   - `BANK` → `bank_id` NOT NULL, `wallet_id` NULL.
 *   - `WALLET` → `wallet_id` NOT NULL, `bank_id` NULL.
 *
 *   Enforced en DB vía CHECK constraint compuesto.
 */
export class CreateCarrierPaymentsTable1747009920000 implements MigrationInterface {
  name = 'CreateCarrierPaymentsTable1747009920000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE carrier_payment_method AS ENUM ('CASH', 'BANK', 'WALLET')
    `);

    await queryRunner.createTable(
      new Table({
        name: 'carrier_payments',
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
            name: 'carrier_credit_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'payment_method',
            type: 'carrier_payment_method',
            isNullable: false,
            enumName: 'carrier_payment_method',
          },
          {
            name: 'bank_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'wallet_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'financial_movement_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'FM auditable. Para CASH es un FM marcador con source_id=null (la caja descontó por log).',
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
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
        ],
        checks: [
          {
            name: 'chk_carrier_payments_amount_positive',
            expression: 'amount > 0',
          },
          {
            name: 'chk_carrier_payments_method_source',
            expression: `(payment_method = 'CASH' AND bank_id IS NULL AND wallet_id IS NULL)
                       OR (payment_method = 'BANK' AND bank_id IS NOT NULL AND wallet_id IS NULL)
                       OR (payment_method = 'WALLET' AND wallet_id IS NOT NULL AND bank_id IS NULL)`,
          },
        ],
      }),
      true,
    );

    // FKs.
    await queryRunner.createForeignKey(
      'carrier_payments',
      new TableForeignKey({
        name: 'fk_carrier_payments_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'carrier_payments',
      new TableForeignKey({
        name: 'fk_carrier_payments_credit_id',
        columnNames: ['carrier_credit_id'],
        referencedTableName: 'carrier_credits',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'carrier_payments',
      new TableForeignKey({
        name: 'fk_carrier_payments_bank_id',
        columnNames: ['bank_id'],
        referencedTableName: 'banks',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'carrier_payments',
      new TableForeignKey({
        name: 'fk_carrier_payments_wallet_id',
        columnNames: ['wallet_id'],
        referencedTableName: 'wallets',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'carrier_payments',
      new TableForeignKey({
        name: 'fk_carrier_payments_fm_id',
        columnNames: ['financial_movement_id'],
        referencedTableName: 'financial_movements',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    await queryRunner.createIndex(
      'carrier_payments',
      new TableIndex({
        name: 'idx_carrier_payments_company_id',
        columnNames: ['company_id'],
      }),
    );

    await queryRunner.createIndex(
      'carrier_payments',
      new TableIndex({
        name: 'idx_carrier_payments_credit_id',
        columnNames: ['carrier_credit_id'],
      }),
    );

    // Soporta el listado filtrado por carrier (a través de credit_id) +
    // rango de fechas. Análisis de pagos del día (analytics).
    await queryRunner.createIndex(
      'carrier_payments',
      new TableIndex({
        name: 'idx_carrier_payments_company_created_at',
        columnNames: ['company_id', 'created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('carrier_payments', 'idx_carrier_payments_company_created_at');
    await queryRunner.dropIndex('carrier_payments', 'idx_carrier_payments_credit_id');
    await queryRunner.dropIndex('carrier_payments', 'idx_carrier_payments_company_id');
    await queryRunner.dropForeignKey('carrier_payments', 'fk_carrier_payments_fm_id');
    await queryRunner.dropForeignKey('carrier_payments', 'fk_carrier_payments_wallet_id');
    await queryRunner.dropForeignKey('carrier_payments', 'fk_carrier_payments_bank_id');
    await queryRunner.dropForeignKey('carrier_payments', 'fk_carrier_payments_credit_id');
    await queryRunner.dropForeignKey('carrier_payments', 'fk_carrier_payments_company_id');
    await queryRunner.dropTable('carrier_payments');
    await queryRunner.query('DROP TYPE IF EXISTS carrier_payment_method');
  }
}
