import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 6 — Crea la tabla `sale_credits`.
 *
 * Espeja `placepos/src/main/database/entities/SaleCredit.ts`. Reutiliza el
 * enum `credit_status` ya creado en `1747008960000-create-purchase-credits-table`.
 *
 * --------------------------------------------------------------------------
 * Modelo
 * --------------------------------------------------------------------------
 *
 *   Sólo se genera un `SaleCredit` cuando la venta queda con saldo pendiente
 *   (`Σ payments < total`). Mientras `total - Σ payments > 0`, el row existe
 *   con `balance > 0`. Al cobrar pagos posteriores se decrementa
 *   `balance` y aumenta `paid_amount`.
 *
 *   Si la venta fue paga 100% al crearse (contado), NO se crea SaleCredit —
 *   espejo PlacePos.
 *
 * --------------------------------------------------------------------------
 * Relación 1:1 con SaleInvoice
 * --------------------------------------------------------------------------
 *
 *   `sale_invoice_id` UNIQUE per-company: cada venta tiene como máximo UN
 *   SaleCredit. El service garantiza la creación atómica.
 *
 * --------------------------------------------------------------------------
 * `due_date`
 * --------------------------------------------------------------------------
 *
 *   PlacePos exige `due_date` (fecha de vencimiento). Si no viene del payload,
 *   se setea a `created_at + 30 days` por defecto. El campo es nullable en
 *   este modelo (sin valor por defecto) — el service decide la política
 *   (PlacePos siempre lo envía, así que en práctica nunca será NULL).
 */
export class CreateSaleCreditsTable1747009440000 implements MigrationInterface {
  name = 'CreateSaleCreditsTable1747009440000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // El tipo enum `credit_status` ya existe (creado en
    // 1747008960000-create-purchase-credits-table). Reutilizamos.
    await queryRunner.createTable(
      new Table({
        name: 'sale_credits',
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
            name: 'customer_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'Denormalizado para listar deudas por cliente sin join. Coincide con sale_invoice.customer_id. NO NULL: el SaleCredit solo existe si hay cliente identificado.',
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
            name: 'due_date',
            type: 'date',
            isNullable: true,
            comment:
              'Fecha de vencimiento. NULL si el cliente no negoció plazo. PlacePos típicamente la define en created_at + 30 days.',
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
            name: 'chk_sale_credits_total_positive',
            expression: 'total_amount > 0',
          },
          {
            name: 'chk_sale_credits_paid_non_negative',
            expression: 'paid_amount >= 0',
          },
          {
            name: 'chk_sale_credits_balance_non_negative',
            expression: 'balance >= 0',
          },
          {
            name: 'chk_sale_credits_paid_lte_total',
            expression: 'paid_amount <= total_amount',
          },
          {
            // Invariante contable: paid + balance == total siempre.
            name: 'chk_sale_credits_balance_consistency',
            expression: 'paid_amount + balance = total_amount',
          },
          {
            // Coherencia status vs amounts.
            name: 'chk_sale_credits_status_consistency',
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
      'sale_credits',
      new TableForeignKey({
        name: 'fk_sale_credits_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a sale_invoices. CASCADE.
    await queryRunner.createForeignKey(
      'sale_credits',
      new TableForeignKey({
        name: 'fk_sale_credits_sale_invoice_id',
        columnNames: ['sale_invoice_id'],
        referencedTableName: 'sale_invoices',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a customers. RESTRICT — no se borra customer con deuda viva.
    await queryRunner.createForeignKey(
      'sale_credits',
      new TableForeignKey({
        name: 'fk_sale_credits_customer_id',
        columnNames: ['customer_id'],
        referencedTableName: 'customers',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    // a) UNIQUE per-company (company_id, sale_invoice_id) — un credit por venta.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_sale_credits_company_sale_unique
      ON sale_credits (company_id, sale_invoice_id)
    `);

    // b) (company_id, customer_id, status) — listar deudas por cliente
    //    (cuentas por cobrar).
    await queryRunner.createIndex(
      'sale_credits',
      new TableIndex({
        name: 'idx_sale_credits_company_customer_status',
        columnNames: ['company_id', 'customer_id', 'status'],
      }),
    );

    // c) (company_id, status, updated_at DESC) — feed cronológico para
    //    dashboards de "lo que se cobra".
    await queryRunner.query(`
      CREATE INDEX idx_sale_credits_company_status_updated
      ON sale_credits (company_id, status, updated_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_credits_company_status_updated');
    await queryRunner.dropIndex('sale_credits', 'idx_sale_credits_company_customer_status');
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_credits_company_sale_unique');
    await queryRunner.dropForeignKey('sale_credits', 'fk_sale_credits_customer_id');
    await queryRunner.dropForeignKey('sale_credits', 'fk_sale_credits_sale_invoice_id');
    await queryRunner.dropForeignKey('sale_credits', 'fk_sale_credits_company_id');
    await queryRunner.dropTable('sale_credits');
  }
}
