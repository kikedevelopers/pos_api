import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 8 — Crea el tipo enum `payment_method` (si no existe) y la tabla
 * `purchase_payments`.
 *
 * Espeja byte-por-byte `placepos/src/main/database/entities/PurchasePayment.ts`:
 *
 *   - Cada abono a una compra genera un row. La compra puede liquidarse en
 *     varios pagos (el PurchaseCredit asociado lleva el saldo).
 *
 *   - `payment_method` enum CASH | TRANSFER.
 *
 *   - `source_type` text 'wallet' | 'bank' | 'cash_register' — espejo del
 *     campo libre de PlacePos, validado por CHECK.
 *
 *   - `source_id` referencia opcional al row de la cuenta (wallet/bank/
 *     cash_register) donde salió el dinero. Snapshot informacional, sin FK
 *     formal (idéntica decisión que `financial_movements`).
 *
 * --------------------------------------------------------------------------
 * Idempotencia per-company
 * --------------------------------------------------------------------------
 *
 * `uuid text` UNIQUE compuesto con `company_id`. El cliente envía un v4 para
 * que un reintento (por timeout o duplicate-click) NO genere un segundo
 * pago. El service detecta el UUID existente y devuelve 200 con el row
 * previo (NO 409).
 *
 * --------------------------------------------------------------------------
 * `payment_number` per-company
 * --------------------------------------------------------------------------
 *
 * Folio incremental per-company (`ABO-001`, `ABO-002`, ...). Generado en la
 * misma transacción del POST con `MAX(payment_number) + 1` bajo advisory
 * lock (mismo patrón que `purchase_number`). UNIQUE composite per-company
 * es la red de seguridad.
 *
 * TODO(Fase 10): reemplazar por TicketSetting.PAYMENT cuando exista.
 */
export class CreatePurchasePaymentsTable1747008900000 implements MigrationInterface {
  name = 'CreatePurchasePaymentsTable1747008900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum `payment_method`. PlacePos lo comparte con sale_payments;
    //    al ser la primera fase que lo necesita, lo creamos aquí.
    await queryRunner.query(`
      CREATE TYPE payment_method AS ENUM ('CASH', 'TRANSFER')
    `);

    // 2. Tabla purchase_payments.
    await queryRunner.createTable(
      new Table({
        name: 'purchase_payments',
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
            name: 'payment_number',
            type: 'text',
            isNullable: false,
            comment:
              'Folio per-company (ABO-001, ABO-002, ...). Generado dentro de la transacción del POST.',
          },
          {
            name: 'payment_method',
            type: 'payment_method',
            isNullable: false,
            enumName: 'payment_method',
          },
          {
            name: 'amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'bank_id',
            type: 'bigint',
            isNullable: true,
            comment:
              'Si payment_method = TRANSFER y la fuente fue un Bank, snapshot del id. Sin FK formal (espejo PlacePos).',
          },
          {
            name: 'bank_name',
            type: 'text',
            isNullable: true,
            comment: 'Snapshot del nombre del banco al momento del pago.',
          },
          {
            name: 'source_type',
            type: 'text',
            isNullable: true,
            comment: `'wallet' | 'bank' | 'cash_register'. Validado por CHECK.`,
          },
          {
            name: 'source_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'notes',
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
            name: 'uuid',
            type: 'text',
            isNullable: true,
            comment:
              'Idempotency key v4 enviado por el cliente. UNIQUE per-company; un retry con el mismo uuid devuelve el row previo (200), no 409.',
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
            name: 'chk_purchase_payments_amount_positive',
            expression: 'amount > 0',
          },
          {
            name: 'chk_purchase_payments_source_type_values',
            expression: `
              source_type IS NULL
              OR source_type IN ('wallet', 'bank', 'cash_register')
            `,
          },
          {
            // Coherencia source_type/source_id.
            name: 'chk_purchase_payments_source_consistency',
            expression: `
              (source_type IS NULL AND source_id IS NULL)
              OR (source_type IS NOT NULL AND source_id IS NOT NULL)
            `,
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'purchase_payments',
      new TableForeignKey({
        name: 'fk_purchase_payments_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a purchases. CASCADE — limpiar pagos si se borra la compra.
    // (En la práctica, las compras se soft-deletean; este CASCADE es defensa
    // contra DELETE administrativo.)
    await queryRunner.createForeignKey(
      'purchase_payments',
      new TableForeignKey({
        name: 'fk_purchase_payments_purchase_id',
        columnNames: ['purchase_id'],
        referencedTableName: 'purchases',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    // a) FK purchase_id — listar pagos de una compra.
    await queryRunner.createIndex(
      'purchase_payments',
      new TableIndex({
        name: 'idx_purchase_payments_purchase_id',
        columnNames: ['purchase_id'],
      }),
    );

    // b) UNIQUE per-company (company_id, payment_number).
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_purchase_payments_company_number_unique
      ON purchase_payments (company_id, payment_number)
    `);

    // c) Idempotencia: UNIQUE compuesto (company_id, uuid) WHERE uuid IS NOT NULL.
    //    Permite que `uuid` sea opcional (legacy clients) pero, cuando viene,
    //    está único per-company. El service consulta este índice ANTES del INSERT.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_purchase_payments_company_uuid_unique
      ON purchase_payments (company_id, uuid)
      WHERE uuid IS NOT NULL
    `);

    // d) (company_id, created_at DESC) — feed cronológico de pagos.
    await queryRunner.query(`
      CREATE INDEX idx_purchase_payments_company_created
      ON purchase_payments (company_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchase_payments_company_created');
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchase_payments_company_uuid_unique');
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchase_payments_company_number_unique');
    await queryRunner.dropIndex('purchase_payments', 'idx_purchase_payments_purchase_id');
    await queryRunner.dropForeignKey('purchase_payments', 'fk_purchase_payments_purchase_id');
    await queryRunner.dropForeignKey('purchase_payments', 'fk_purchase_payments_company_id');
    await queryRunner.dropTable('purchase_payments');
    await queryRunner.query('DROP TYPE IF EXISTS payment_method');
  }
}
