import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Módulo Domiciliarios — Crea la tabla `deliveries` (domicilios / entregas).
 *
 * Espejo del feature "Domiciliarios" de PlacePos con extensión multi-tenant.
 *
 * --------------------------------------------------------------------------
 * Decisiones de modelado
 * --------------------------------------------------------------------------
 *
 *   - `invoice_id` FK a `sale_invoices` ON DELETE SET NULL — un domicilio
 *     puede o no estar ligado a una venta; si la venta se borra, el domicilio
 *     persiste sin la referencia. `ticket_number` es snapshot.
 *
 *   - `delivery_company_id` FK a `delivery_companies` ON DELETE RESTRICT — no
 *     se puede borrar un domiciliario con entregas. `delivery_company_name`
 *     es snapshot del nombre al momento del registro.
 *
 *   - `amount numeric(15,2) >= 0` — Money rule. >= 0 (no > 0) porque un
 *     domicilio puede registrarse con valor 0 (cortesía / sin costo).
 *
 *   - `payment_method` text validado por CHECK ('on_delivery' | 'cash_register').
 *
 *   - `cash_register_log_id bigint NULL` — enlaza con el CashRegisterLog del
 *     egreso cuando payment_method=cash_register. Sin FK formal: el log es
 *     auditoría inmutable y no queremos un ON DELETE que toque domicilios.
 *
 *   - `is_archived boolean` — soft-delete; al archivar un domicilio pagado de
 *     caja, la action revierte el egreso (ingreso a la caja original).
 *
 * --------------------------------------------------------------------------
 * Side effects en mutaciones (orquestados por las actions, no por DB)
 * --------------------------------------------------------------------------
 *
 *   - INSERT delivery con payment_method=cash_register → debita la caja del
 *     cajero + INSERT CashRegisterLog(DELIVERY_PAYMENT, OUT).
 *   - ARCHIVE (is_archived=true) de un delivery cash_register → revierte el
 *     egreso + INSERT CashRegisterLog(VOID_DELIVERY_PAYMENT, IN).
 *
 * --------------------------------------------------------------------------
 * Índices
 * --------------------------------------------------------------------------
 *
 *   a) `(company_id)` — lookups por tenant.
 *   b) `(company_id, created_at DESC) WHERE is_archived = false` — feed
 *      principal (lista filtrada por rango de fechas).
 *   c) `(company_id, delivery_company_id)` — filtro por domiciliario.
 *   d) `(company_id, payment_method)` — filtro por método de pago.
 *   e) `(invoice_id) WHERE invoice_id IS NOT NULL` — domicilios de una venta.
 */
export class CreateDeliveriesTable1747011080000 implements MigrationInterface {
  name = 'CreateDeliveriesTable1747011080000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'deliveries',
        columns: [
          { name: 'id', type: 'bigserial', isPrimary: true },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Tenant. Asignado por el service desde req.user.company_id.',
          },
          { name: 'invoice_id', type: 'bigint', isNullable: true },
          {
            name: 'ticket_number',
            type: 'text',
            isNullable: true,
            comment: 'Snapshot del ticket de la venta ligada.',
          },
          { name: 'delivery_company_id', type: 'bigint', isNullable: false },
          {
            name: 'delivery_company_name',
            type: 'text',
            isNullable: false,
            comment: 'Snapshot del nombre del domiciliario al momento del registro.',
          },
          { name: 'amount', type: 'numeric', precision: 15, scale: 2, isNullable: false },
          {
            name: 'payment_method',
            type: 'text',
            isNullable: false,
            comment: `'on_delivery' | 'cash_register'. Validado por CHECK.`,
          },
          { name: 'notes', type: 'text', isNullable: true },
          { name: 'destination_address', type: 'text', isNullable: false },
          { name: 'recipient_name', type: 'text', isNullable: false },
          {
            name: 'cash_register_log_id',
            type: 'bigint',
            isNullable: true,
            comment: 'Enlace al CashRegisterLog del egreso (solo si payment_method=cash_register).',
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment: 'Soft-delete. true cuando el domicilio fue anulado (revierte egreso de caja).',
          },
          { name: 'created_by', type: 'text', isNullable: true },
          { name: 'created_by_id', type: 'bigint', isNullable: true },
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
            name: 'chk_deliveries_amount_non_negative',
            expression: 'amount >= 0',
          },
          {
            name: 'chk_deliveries_payment_method_values',
            expression: `payment_method IN ('on_delivery', 'cash_register')`,
          },
          {
            name: 'chk_deliveries_destination_address_not_empty',
            expression: 'length(btrim(destination_address)) > 0',
          },
          {
            name: 'chk_deliveries_recipient_name_not_empty',
            expression: 'length(btrim(recipient_name)) > 0',
          },
        ],
      }),
      true,
    );

    // FK a companies (tenant).
    await queryRunner.createForeignKey(
      'deliveries',
      new TableForeignKey({
        name: 'fk_deliveries_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a sale_invoices — ON DELETE SET NULL (preserva el domicilio histórico).
    await queryRunner.createForeignKey(
      'deliveries',
      new TableForeignKey({
        name: 'fk_deliveries_invoice_id',
        columnNames: ['invoice_id'],
        referencedTableName: 'sale_invoices',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a delivery_companies — ON DELETE RESTRICT (no borrar domiciliario con entregas).
    await queryRunner.createForeignKey(
      'deliveries',
      new TableForeignKey({
        name: 'fk_deliveries_delivery_company_id',
        columnNames: ['delivery_company_id'],
        referencedTableName: 'delivery_companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // a) Índice por tenant.
    await queryRunner.createIndex(
      'deliveries',
      new TableIndex({ name: 'idx_deliveries_company_id', columnNames: ['company_id'] }),
    );

    // b) Feed principal.
    await queryRunner.query(`
      CREATE INDEX idx_deliveries_company_created_active
      ON deliveries (company_id, created_at DESC)
      WHERE is_archived = false
    `);

    // c) Filtro por domiciliario.
    await queryRunner.createIndex(
      'deliveries',
      new TableIndex({
        name: 'idx_deliveries_company_delivery_company',
        columnNames: ['company_id', 'delivery_company_id'],
      }),
    );

    // d) Filtro por método de pago.
    await queryRunner.createIndex(
      'deliveries',
      new TableIndex({
        name: 'idx_deliveries_company_payment_method',
        columnNames: ['company_id', 'payment_method'],
      }),
    );

    // e) Domicilios de una venta.
    await queryRunner.query(`
      CREATE INDEX idx_deliveries_invoice
      ON deliveries (invoice_id)
      WHERE invoice_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_deliveries_invoice');
    await queryRunner.dropIndex('deliveries', 'idx_deliveries_company_payment_method');
    await queryRunner.dropIndex('deliveries', 'idx_deliveries_company_delivery_company');
    await queryRunner.query('DROP INDEX IF EXISTS idx_deliveries_company_created_active');
    await queryRunner.dropIndex('deliveries', 'idx_deliveries_company_id');
    await queryRunner.dropForeignKey('deliveries', 'fk_deliveries_delivery_company_id');
    await queryRunner.dropForeignKey('deliveries', 'fk_deliveries_invoice_id');
    await queryRunner.dropForeignKey('deliveries', 'fk_deliveries_company_id');
    await queryRunner.dropTable('deliveries');
  }
}
