import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 6 — Crea el tipo enum `ticket_type` (si no existe) y la tabla
 * `sale_invoices`.
 *
 * Espeja byte-por-byte `placepos/src/main/database/entities/SaleInvoice.ts`
 * con adaptación multi-tenant:
 *
 *   - `company_id bigint NOT NULL` con FK a `companies`.
 *   - `ticket_number` único per-company (no GLOBAL como PlacePos local).
 *   - `sale_number` único per-company entre no-nulos (cuando se convierte
 *     ORDER → SALE).
 *
 * --------------------------------------------------------------------------
 * Modelo de tipos
 * --------------------------------------------------------------------------
 *
 *   - `ORDER`: pedido editable, anulable directo (soft-delete) sin nota.
 *   - `SALE`: venta confirmada, solo anulable vía CreditNote (Fase 8).
 *
 *   La transición `ORDER → SALE` se hace vía `POST /sales/:id/convert` (o
 *   automáticamente al registrar primer pago — política PlacePos). El
 *   campo `sale_number` se llena con el folio SALE en ese momento.
 *
 * --------------------------------------------------------------------------
 * Folio per-company (`ticket_number` / `sale_number`)
 * --------------------------------------------------------------------------
 *
 *   Generados atómicamente vía `IncrementTicketNumberAction` que hace
 *   `UPDATE ticket_settings SET current_number = current_number + 1 ...
 *   RETURNING current_number, prefix, suffix` dentro de la transacción del
 *   POST. El UNIQUE per-company es la red de seguridad si algo bypassa el
 *   counter.
 *
 * --------------------------------------------------------------------------
 * Soft-delete
 * --------------------------------------------------------------------------
 *
 *   `is_deleted boolean` — convención PlacePos (NO `is_archived`). Las
 *   queries de listado filtran `is_deleted = false`. Las ventas anuladas
 *   permanecen físicamente para preservar la auditoría (un CreditNote
 *   histórico puede referenciarlas).
 *
 * --------------------------------------------------------------------------
 * `customer_id` nullable
 * --------------------------------------------------------------------------
 *
 *   Las ventas mostrador (cliente "consumidor final" sin registro) pueden
 *   crearse sin customer. Si llega, se valida que pertenezca a la company.
 */
export class CreateSaleInvoicesTable1747009260000 implements MigrationInterface {
  name = 'CreateSaleInvoicesTable1747009260000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum `ticket_type`. PlacePos lo comparte con CreditNote y
    //    notas; aquí solo definimos ORDER/SALE — los otros tipos
    //    (CREDIT_NOTE, DEBIT_NOTE, PURCHASE) viven en `ticket_setting_type`
    //    (definido en migración 1747009020000) que es OTRO type distinto.
    await queryRunner.query(`
      CREATE TYPE ticket_type AS ENUM ('ORDER', 'SALE')
    `);

    await queryRunner.createTable(
      new Table({
        name: 'sale_invoices',
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
              'Tenant al que pertenece la venta. Asignado por el service desde req.user.company_id; nunca aceptado del payload.',
          },
          {
            name: 'ticket_type',
            type: 'ticket_type',
            isNullable: false,
            enumName: 'ticket_type',
            default: `'ORDER'`,
          },
          {
            name: 'ticket_number',
            type: 'text',
            isNullable: false,
            comment:
              'Folio del ticket (ORDER inicialmente). Único per-company. Generado por IncrementTicketNumberAction.',
          },
          {
            name: 'sale_number',
            type: 'text',
            isNullable: true,
            comment:
              'Folio de SALE asignado al convertir ORDER → SALE. NULL mientras la venta sea ORDER.',
          },
          {
            name: 'customer_id',
            type: 'bigint',
            isNullable: true,
            comment: 'Cliente asociado. NULL para ventas mostrador (consumidor final).',
          },
          {
            name: 'customer_name',
            type: 'text',
            isNullable: true,
            comment:
              'Snapshot del nombre del cliente al crear la venta. Inmutable; espejo PlacePos.',
          },
          {
            name: 'subtotal',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'tax_total',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Σ(line.iva_amount). PlacePos no discrimina IVA en sales pero exponemos 0.',
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
            name: 'cost',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Σ(line.cost * line.quantity). Snapshot para reportes de ganancia.',
          },
          {
            name: 'profit',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'total - cost (snapshot al momento de la venta).',
          },
          {
            name: 'margin',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
            comment: 'Porcentaje (profit / total) * 100. Espejo PlacePos.',
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
            name: 'is_deleted',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment:
              'Soft-delete convención PlacePos. is_deleted (NO is_archived) — espejo byte-por-byte.',
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
            name: 'chk_sale_invoices_ticket_number_not_empty',
            expression: 'length(btrim(ticket_number)) > 0',
          },
          {
            name: 'chk_sale_invoices_subtotal_non_negative',
            expression: 'subtotal >= 0',
          },
          {
            name: 'chk_sale_invoices_tax_total_non_negative',
            expression: 'tax_total >= 0',
          },
          {
            name: 'chk_sale_invoices_total_non_negative',
            expression: 'total >= 0',
          },
          {
            name: 'chk_sale_invoices_cost_non_negative',
            expression: 'cost >= 0',
          },
          {
            // SALE requiere sale_number poblado; ORDER lo permite NULL.
            name: 'chk_sale_invoices_sale_number_consistency',
            expression: `
              ticket_type = 'ORDER'
              OR (ticket_type = 'SALE' AND length(btrim(coalesce(sale_number, ''))) > 0)
            `,
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'sale_invoices',
      new TableForeignKey({
        name: 'fk_sale_invoices_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a customers (nullable). SET NULL si se borra el customer físicamente
    // — pero en práctica los customers se archivan, no se borran.
    await queryRunner.createForeignKey(
      'sale_invoices',
      new TableForeignKey({
        name: 'fk_sale_invoices_customer_id',
        columnNames: ['customer_id'],
        referencedTableName: 'customers',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    // a) (company_id) — FK filter caliente.
    await queryRunner.createIndex(
      'sale_invoices',
      new TableIndex({
        name: 'idx_sale_invoices_company_id',
        columnNames: ['company_id'],
      }),
    );

    // b) UNIQUE per-company (company_id, ticket_number).
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_sale_invoices_company_ticket_number_unique
      ON sale_invoices (company_id, ticket_number)
    `);

    // c) UNIQUE per-company (company_id, sale_number) WHERE sale_number IS NOT NULL.
    //    El sale_number solo se llena al convertir ORDER → SALE; antes de
    //    eso permitimos NULL.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_sale_invoices_company_sale_number_unique
      ON sale_invoices (company_id, sale_number)
      WHERE sale_number IS NOT NULL
    `);

    // d) (company_id, created_at DESC) WHERE is_deleted = false — feed
    //    cronológico que cubre `GET /sales`.
    await queryRunner.query(`
      CREATE INDEX idx_sale_invoices_company_active_created
      ON sale_invoices (company_id, created_at DESC)
      WHERE is_deleted = false
    `);

    // e) (company_id, customer_id, created_at DESC) — cubre
    //    `GET /sales/by-customer/:customerId` y reportes por cliente.
    await queryRunner.query(`
      CREATE INDEX idx_sale_invoices_company_customer_created
      ON sale_invoices (company_id, customer_id, created_at DESC)
      WHERE is_deleted = false
    `);

    // f) (company_id, ticket_type) WHERE is_deleted = false — filtra
    //    ORDER vs SALE para dashboards.
    await queryRunner.query(`
      CREATE INDEX idx_sale_invoices_company_ticket_type
      ON sale_invoices (company_id, ticket_type)
      WHERE is_deleted = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_invoices_company_ticket_type');
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_invoices_company_customer_created');
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_invoices_company_active_created');
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_invoices_company_sale_number_unique');
    await queryRunner.query('DROP INDEX IF EXISTS idx_sale_invoices_company_ticket_number_unique');
    await queryRunner.dropIndex('sale_invoices', 'idx_sale_invoices_company_id');
    await queryRunner.dropForeignKey('sale_invoices', 'fk_sale_invoices_customer_id');
    await queryRunner.dropForeignKey('sale_invoices', 'fk_sale_invoices_company_id');
    await queryRunner.dropTable('sale_invoices');
    await queryRunner.query('DROP TYPE IF EXISTS ticket_type');
  }
}
