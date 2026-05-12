import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 6 — Crea la tabla `sale_payments`.
 *
 * Espeja byte-por-byte `placepos/src/main/database/entities/SalePayment.ts`:
 *
 *   - Cada cobro a una venta. La venta puede liquidarse en múltiples pagos
 *     mientras tenga `SaleCredit.balance > 0`.
 *
 *   - `payment_method` reutiliza el enum `payment_method` (CASH | TRANSFER)
 *     creado en migración 1747008900000 (purchase_payments).
 *
 *   - `source_type` text 'wallet' | 'bank' | 'cash_register' — espejo del
 *     campo libre de PlacePos, validado por CHECK.
 *
 * --------------------------------------------------------------------------
 * Idempotencia per-company
 * --------------------------------------------------------------------------
 *
 *   `uuid text` UNIQUE compuesto con `company_id` (índice parcial). El
 *   cliente PlacePos genera un UUID v4 para evitar duplicar cobros en
 *   retries por timeout o reintento de red. El service detecta y devuelve
 *   200 con el row existente.
 *
 * --------------------------------------------------------------------------
 * Side effects al insertar (orquestados por la action en una transacción)
 * --------------------------------------------------------------------------
 *
 *   1. Debita o acredita la fuente:
 *      - wallet / bank: UPDATE balance += amount con SELECT FOR UPDATE.
 *      - cash_register: INSERT CashRegisterLog(IN, CASH_IN).
 *   2. INSERT FinancialMovement(INCOME, SALE) con source=external (cliente)
 *      y destination=cuenta receptora.
 *   3. Actualiza SaleCredit.balance / paid_amount / status si la venta era
 *      a crédito. Decrementa Customer.balance si aplica.
 */
export class CreateSalePaymentsTable1747009380000 implements MigrationInterface {
  name = 'CreateSalePaymentsTable1747009380000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // El tipo enum `payment_method` ya existe (creado en
    // 1747008900000-create-purchase-payments-table). Reutilizamos.
    await queryRunner.createTable(
      new Table({
        name: 'sale_payments',
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
            name: 'sale_invoice_id',
            type: 'bigint',
            isNullable: false,
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
            name: 'change_amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment:
              'Cambio devuelto al cliente cuando paga con exceso (espejo PlacePos `change_amount`).',
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
            name: 'account_type',
            type: 'text',
            isNullable: false,
            comment: `'wallet' | 'bank' | 'cash_register'. Validado por CHECK.`,
          },
          {
            name: 'account_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'ID de la cuenta receptora (wallet.id | bank.id | cash_register.id). Sin FK formal — el tipo varía.',
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
              'Idempotency key v4 enviado por el cliente. UNIQUE per-company. Un retry con el mismo uuid devuelve el row previo (200), no 409.',
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
            name: 'chk_sale_payments_amount_positive',
            expression: 'amount > 0',
          },
          {
            name: 'chk_sale_payments_change_non_negative',
            expression: 'change_amount >= 0',
          },
          {
            name: 'chk_sale_payments_account_type_values',
            expression: `account_type IN ('wallet', 'bank', 'cash_register')`,
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'sale_payments',
      new TableForeignKey({
        name: 'fk_sale_payments_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a sale_invoices. CASCADE — limpiar pagos si la venta se borra.
    await queryRunner.createForeignKey(
      'sale_payments',
      new TableForeignKey({
        name: 'fk_sale_payments_sale_invoice_id',
        columnNames: ['sale_invoice_id'],
        referencedTableName: 'sale_invoices',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    // a) FK sale_invoice_id — listar pagos de una venta.
    await queryRunner.createIndex(
      'sale_payments',
      new TableIndex({
        name: 'idx_sale_payments_sale_invoice_id',
        columnNames: ['sale_invoice_id'],
      }),
    );

    // b) Idempotencia: UNIQUE compuesto (company_id, uuid) WHERE uuid IS NOT NULL.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_sale_payments_company_uuid_unique
      ON sale_payments (company_id, uuid)
      WHERE uuid IS NOT NULL
    `);

    // c) (company_id, created_at DESC) — feed cronológico de pagos.
    await queryRunner.query(`
      CREATE INDEX idx_sale_payments_company_created
      ON sale_payments (company_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_payments_company_created');
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_payments_company_uuid_unique');
    await queryRunner.dropIndex('sale_payments', 'idx_sale_payments_sale_invoice_id');
    await queryRunner.dropForeignKey('sale_payments', 'fk_sale_payments_sale_invoice_id');
    await queryRunner.dropForeignKey('sale_payments', 'fk_sale_payments_company_id');
    await queryRunner.dropTable('sale_payments');
  }
}
