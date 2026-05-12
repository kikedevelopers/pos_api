import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 8 — Crea el tipo enum `credit_status` y la tabla `purchase_credits`.
 *
 * Espeja byte-por-byte
 * `placepos/src/main/database/entities/PurchaseCredit.ts`.
 *
 * --------------------------------------------------------------------------
 * Modelo
 * --------------------------------------------------------------------------
 *
 *   Cada `Purchase` genera AL CREARSE un `PurchaseCredit` con
 *   `total_amount = purchase.total`, `paid_amount = 0`, `balance =
 *   purchase.total`, `status = PENDING`.
 *
 *   Cada `PurchasePayment` decrementa `paid_amount += amount` y
 *   `balance -= amount`. El status pasa a:
 *     - `PARTIALLY_PAID` cuando `paid_amount > 0` y `balance > 0`,
 *     - `PAID` cuando `balance = 0`.
 *
 *   La columna `paid_amount` es redundante con `total_amount - balance` pero
 *   la mantenemos por paridad PlacePos (el frontend la lee directo).
 *
 * --------------------------------------------------------------------------
 * Relación 1:1 con Purchase
 * --------------------------------------------------------------------------
 *
 *   `purchase_id` UNIQUE per-company: cada compra tiene exactamente UN
 *   PurchaseCredit. El service garantiza la creación atómica.
 */
export class CreatePurchaseCreditsTable1747008960000 implements MigrationInterface {
  name = 'CreatePurchaseCreditsTable1747008960000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum `credit_status`. Compartido con sales/credit-notes en
    //    fases posteriores; lo creamos aquí porque es la primera ocurrencia.
    await queryRunner.query(`
      CREATE TYPE credit_status AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID')
    `);

    // 2. Tabla purchase_credits.
    await queryRunner.createTable(
      new Table({
        name: 'purchase_credits',
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
            name: 'purchase_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'supplier_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'Denormalizado para listar deudas por proveedor sin join. Coincide con purchase.supplier_id.',
          },
          {
            name: 'total_amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
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
          },
          {
            name: 'status',
            type: 'credit_status',
            isNullable: false,
            enumName: 'credit_status',
            default: `'PENDING'`,
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
            name: 'chk_purchase_credits_total_positive',
            expression: 'total_amount > 0',
          },
          {
            name: 'chk_purchase_credits_paid_non_negative',
            expression: 'paid_amount >= 0',
          },
          {
            name: 'chk_purchase_credits_balance_non_negative',
            expression: 'balance >= 0',
          },
          {
            name: 'chk_purchase_credits_paid_lte_total',
            expression: 'paid_amount <= total_amount',
          },
          {
            // Invariante contable: paid + balance == total siempre.
            name: 'chk_purchase_credits_balance_consistency',
            expression: 'paid_amount + balance = total_amount',
          },
          {
            // Coherencia status vs amounts.
            name: 'chk_purchase_credits_status_consistency',
            expression: `
              (status = 'PENDING' AND paid_amount = 0)
              OR (status = 'PARTIALLY_PAID' AND paid_amount > 0 AND balance > 0)
              OR (status = 'PAID' AND balance = 0 AND paid_amount = total_amount)
            `,
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'purchase_credits',
      new TableForeignKey({
        name: 'fk_purchase_credits_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a purchases. CASCADE — al borrar la compra (raro) limpia su credit.
    await queryRunner.createForeignKey(
      'purchase_credits',
      new TableForeignKey({
        name: 'fk_purchase_credits_purchase_id',
        columnNames: ['purchase_id'],
        referencedTableName: 'purchases',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a suppliers. RESTRICT.
    await queryRunner.createForeignKey(
      'purchase_credits',
      new TableForeignKey({
        name: 'fk_purchase_credits_supplier_id',
        columnNames: ['supplier_id'],
        referencedTableName: 'suppliers',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    // a) UNIQUE per-company (company_id, purchase_id) — un credit por compra.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_purchase_credits_company_purchase_unique
      ON purchase_credits (company_id, purchase_id)
    `);

    // b) (company_id, supplier_id, status) — listar deudas pendientes/parciales
    //    por proveedor (vista de cuentas por pagar).
    await queryRunner.createIndex(
      'purchase_credits',
      new TableIndex({
        name: 'idx_purchase_credits_company_supplier_status',
        columnNames: ['company_id', 'supplier_id', 'status'],
      }),
    );

    // c) (company_id, status, updated_at DESC) — feed cronológico para
    //    dashboards de "lo que se debe".
    await queryRunner.query(`
      CREATE INDEX idx_purchase_credits_company_status_updated
      ON purchase_credits (company_id, status, updated_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchase_credits_company_status_updated');
    await queryRunner.dropIndex('purchase_credits', 'idx_purchase_credits_company_supplier_status');
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchase_credits_company_purchase_unique');
    await queryRunner.dropForeignKey('purchase_credits', 'fk_purchase_credits_supplier_id');
    await queryRunner.dropForeignKey('purchase_credits', 'fk_purchase_credits_purchase_id');
    await queryRunner.dropForeignKey('purchase_credits', 'fk_purchase_credits_company_id');
    await queryRunner.dropTable('purchase_credits');
    await queryRunner.query('DROP TYPE IF EXISTS credit_status');
  }
}
