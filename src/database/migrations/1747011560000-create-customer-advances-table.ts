import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Anticipos de cliente — Crea la tabla `customer_advances`.
 *
 * Espejo del feature "Anticipo de cliente"
 * (`CONTRACT_customer_advance_archive.md`) con extensión multi-tenant.
 *
 * --------------------------------------------------------------------------
 * Decisiones de modelado
 * --------------------------------------------------------------------------
 *
 *   - `company_id` FK a `companies` ON DELETE RESTRICT — no se borra company
 *     con anticipos. Índice por tenant.
 *
 *   - `customer_id` FK a `customers` ON DELETE RESTRICT — no se borra un
 *     cliente con anticipos registrados (auditoría financiera). Índice.
 *
 *   - `amount numeric(15,2) > 0` — Money rule. Un anticipo siempre es > 0.
 *
 *   - `description text NOT NULL` no vacío — concepto que también se propaga al
 *     movimiento de caja/financiero generado.
 *
 *   - `destination_type text` validado por CHECK
 *     ('cash_register' | 'bank' | 'wallet').
 *
 *   - `destination_id bigint NOT NULL` — id real de la cuenta destino. Sin FK
 *     formal: el tipo de cuenta es polimórfico (caja/banco/billetera viven en
 *     tablas distintas), así que la integridad la garantiza la action dentro
 *     de la transacción (resuelve y valida ownership antes de insertar).
 *
 *   - `reference_code text NULL` — uuid para trazar contra el CashRegisterLog
 *     o FinancialMovement generado.
 *
 *   - Sin `updated_at`: el anticipo es inmutable en esta entrega (sin reversa).
 *
 * --------------------------------------------------------------------------
 * Índices
 * --------------------------------------------------------------------------
 *
 *   a) `(company_id)` — lookups por tenant + soporte al RESTRICT on delete.
 *   b) `(customer_id)` — soporte al RESTRICT on delete del customer.
 *   c) `(company_id, customer_id, created_at DESC)` — listado de anticipos de
 *      un cliente ordenado por fecha (GET /customers/:id/advances).
 */
export class CreateCustomerAdvancesTable1747011560000 implements MigrationInterface {
  name = 'CreateCustomerAdvancesTable1747011560000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'customer_advances',
        columns: [
          { name: 'id', type: 'bigserial', isPrimary: true },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Tenant. Asignado por el service desde req.user.company_id.',
          },
          { name: 'customer_id', type: 'bigint', isNullable: false },
          { name: 'amount', type: 'numeric', precision: 15, scale: 2, isNullable: false },
          {
            name: 'description',
            type: 'text',
            isNullable: false,
            comment: 'Concepto del anticipo; se propaga al movimiento de caja/financiero.',
          },
          {
            name: 'destination_type',
            type: 'text',
            isNullable: false,
            comment: `'cash_register' | 'bank' | 'wallet'. Validado por CHECK.`,
          },
          {
            name: 'destination_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'Id real de la cuenta destino (caja del cajero / banco / billetera). Sin FK por ser polimórfico.',
          },
          {
            name: 'reference_code',
            type: 'text',
            isNullable: true,
            comment: 'uuid para trazar contra el CashRegisterLog/FinancialMovement generado.',
          },
          { name: 'created_by', type: 'text', isNullable: true },
          { name: 'created_by_id', type: 'bigint', isNullable: true },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
        checks: [
          {
            name: 'chk_customer_advances_amount_positive',
            expression: 'amount > 0',
          },
          {
            name: 'chk_customer_advances_destination_type',
            expression: `destination_type IN ('cash_register', 'bank', 'wallet')`,
          },
          {
            name: 'chk_customer_advances_description_not_empty',
            expression: 'length(btrim(description)) > 0',
          },
        ],
      }),
      true,
    );

    // FK a companies (tenant).
    await queryRunner.createForeignKey(
      'customer_advances',
      new TableForeignKey({
        name: 'fk_customer_advances_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a customers — RESTRICT (no borrar cliente con anticipos).
    await queryRunner.createForeignKey(
      'customer_advances',
      new TableForeignKey({
        name: 'fk_customer_advances_customer_id',
        columnNames: ['customer_id'],
        referencedTableName: 'customers',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // a) Índice por tenant.
    await queryRunner.createIndex(
      'customer_advances',
      new TableIndex({
        name: 'idx_customer_advances_company_id',
        columnNames: ['company_id'],
      }),
    );

    // b) Índice por customer (soporta el RESTRICT del FK).
    await queryRunner.createIndex(
      'customer_advances',
      new TableIndex({
        name: 'idx_customer_advances_customer_id',
        columnNames: ['customer_id'],
      }),
    );

    // c) Listado de anticipos de un cliente ordenado por fecha.
    await queryRunner.createIndex(
      'customer_advances',
      new TableIndex({
        name: 'idx_customer_advances_company_customer_created',
        columnNames: ['company_id', 'customer_id', 'created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex(
      'customer_advances',
      'idx_customer_advances_company_customer_created',
    );
    await queryRunner.dropIndex('customer_advances', 'idx_customer_advances_customer_id');
    await queryRunner.dropIndex('customer_advances', 'idx_customer_advances_company_id');
    await queryRunner.dropForeignKey('customer_advances', 'fk_customer_advances_customer_id');
    await queryRunner.dropForeignKey('customer_advances', 'fk_customer_advances_company_id');
    await queryRunner.dropTable('customer_advances');
  }
}
