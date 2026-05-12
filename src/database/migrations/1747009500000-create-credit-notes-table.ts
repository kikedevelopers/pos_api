import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 7 — Crea los enums `note_type` y `operation_type` (si no existen) y la
 * tabla `credit_notes`.
 *
 * Espeja `placepos/src/main/database/entities/CreditNote.ts` con adaptación
 * multi-tenant:
 *
 *   - `company_id bigint NOT NULL` con FK a `companies`.
 *   - `note_number` UNIQUE per-company (PlacePos local lo tiene UNIQUE GLOBAL).
 *
 * --------------------------------------------------------------------------
 * Modelo
 * --------------------------------------------------------------------------
 *
 *   Una `CreditNote` representa una corrección sobre una `SaleInvoice` con
 *   `ticket_type = SALE` (no se anula ORDER por nota — esa se soft-deletea
 *   directo). El `note_type` discrimina:
 *
 *     - `CREDIT`: reduce el total consolidado. Combina con FULL_VOID o
 *       PARTIAL_VOID.
 *     - `DEBIT`: aumenta el total consolidado. Combina solo con ADDITION.
 *
 *   El `operation_type` indica el tipo de operación contable:
 *     - `FULL_VOID`: anula la venta completa (solo una por venta).
 *     - `PARTIAL_VOID`: anula líneas o cantidades específicas.
 *     - `ADDITION`: agrega cargos (intereses, recargos).
 *
 *   Combinaciones legales (rechazar el resto con 422):
 *     - CREDIT + FULL_VOID
 *     - CREDIT + PARTIAL_VOID
 *     - DEBIT  + ADDITION
 *
 * --------------------------------------------------------------------------
 * Folio per-company (`note_number`)
 * --------------------------------------------------------------------------
 *
 *   Generado atómicamente vía `IncrementTicketNumberAction` con
 *   `TicketSettingType.CREDIT_NOTE` o `DEBIT_NOTE` según `note_type`. El
 *   UNIQUE per-company es la red de seguridad si algo bypassa el counter.
 *
 * --------------------------------------------------------------------------
 * Soft-delete
 * --------------------------------------------------------------------------
 *
 *   `is_deleted boolean` — convención PlacePos. Las notas anuladas conservan
 *   el histórico contable para la auditoría.
 */
export class CreateCreditNotesTable1747009500000 implements MigrationInterface {
  name = 'CreateCreditNotesTable1747009500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipos enum. `note_type` y `operation_type` aún no existen en otras
    //    migraciones — los creamos aquí.
    await queryRunner.query(`CREATE TYPE note_type AS ENUM ('CREDIT', 'DEBIT')`);
    await queryRunner.query(
      `CREATE TYPE operation_type AS ENUM ('FULL_VOID', 'PARTIAL_VOID', 'ADDITION')`,
    );

    await queryRunner.createTable(
      new Table({
        name: 'credit_notes',
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
              'Tenant al que pertenece la nota. Asignado por el service desde req.user.company_id; nunca aceptado del payload.',
          },
          {
            name: 'sale_invoice_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'Venta sobre la que opera la nota. RESTRICT: no se borra la venta mientras tenga notas activas.',
          },
          {
            name: 'customer_id',
            type: 'bigint',
            isNullable: true,
            comment:
              'Snapshot del cliente al momento de la nota. SET NULL si se borra físicamente al customer.',
          },
          {
            name: 'note_number',
            type: 'text',
            isNullable: false,
            comment: 'Folio per-company. NC-XXX (CREDIT) o ND-XXX (DEBIT).',
          },
          {
            name: 'note_type',
            type: 'note_type',
            isNullable: false,
            enumName: 'note_type',
          },
          {
            name: 'operation_type',
            type: 'operation_type',
            isNullable: false,
            enumName: 'operation_type',
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
            name: 'reason',
            type: 'text',
            isNullable: true,
            comment: 'Motivo libre de la nota (espejo PlacePos `reason`).',
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
            comment: 'Soft-delete convención PlacePos.',
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
            name: 'chk_credit_notes_note_number_not_empty',
            expression: 'length(btrim(note_number)) > 0',
          },
          {
            name: 'chk_credit_notes_subtotal_non_negative',
            expression: 'subtotal >= 0',
          },
          {
            name: 'chk_credit_notes_tax_total_non_negative',
            expression: 'tax_total >= 0',
          },
          {
            name: 'chk_credit_notes_total_non_negative',
            expression: 'total >= 0',
          },
          {
            // Combinaciones legales note_type x operation_type.
            name: 'chk_credit_notes_type_operation_consistency',
            expression: `
              (note_type = 'CREDIT' AND operation_type IN ('FULL_VOID', 'PARTIAL_VOID'))
              OR (note_type = 'DEBIT' AND operation_type = 'ADDITION')
            `,
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'credit_notes',
      new TableForeignKey({
        name: 'fk_credit_notes_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a sale_invoices. RESTRICT — no se borra venta con notas.
    await queryRunner.createForeignKey(
      'credit_notes',
      new TableForeignKey({
        name: 'fk_credit_notes_sale_invoice_id',
        columnNames: ['sale_invoice_id'],
        referencedTableName: 'sale_invoices',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a customers (nullable). SET NULL si se borra físicamente al customer.
    await queryRunner.createForeignKey(
      'credit_notes',
      new TableForeignKey({
        name: 'fk_credit_notes_customer_id',
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
      'credit_notes',
      new TableIndex({
        name: 'idx_credit_notes_company_id',
        columnNames: ['company_id'],
      }),
    );

    // b) UNIQUE per-company (company_id, note_number).
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_credit_notes_company_note_number_unique
      ON credit_notes (company_id, note_number)
    `);

    // c) (company_id, sale_invoice_id) — listar notas de una venta.
    await queryRunner.createIndex(
      'credit_notes',
      new TableIndex({
        name: 'idx_credit_notes_company_sale_invoice',
        columnNames: ['company_id', 'sale_invoice_id'],
      }),
    );

    // d) (company_id, created_at DESC) WHERE is_deleted = false — feed
    //    cronológico activo.
    await queryRunner.query(`
      CREATE INDEX idx_credit_notes_company_active_created
      ON credit_notes (company_id, created_at DESC)
      WHERE is_deleted = false
    `);

    // e) UNIQUE parcial: SOLO UNA nota FULL_VOID activa por venta.
    //    PlacePos protege esta regla a nivel de service; nosotros la
    //    blindamos también a nivel físico (defense in depth).
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_credit_notes_one_full_void_per_sale
      ON credit_notes (company_id, sale_invoice_id)
      WHERE operation_type = 'FULL_VOID' AND is_deleted = false
    `);

    // f) (company_id, customer_id, created_at DESC) WHERE is_deleted = false —
    //    histórico de notas por cliente.
    await queryRunner.query(`
      CREATE INDEX idx_credit_notes_company_customer_created
      ON credit_notes (company_id, customer_id, created_at DESC)
      WHERE is_deleted = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_credit_notes_company_customer_created');
    await queryRunner.query('DROP INDEX IF EXISTS idx_credit_notes_one_full_void_per_sale');
    await queryRunner.query('DROP INDEX IF EXISTS idx_credit_notes_company_active_created');
    await queryRunner.dropIndex('credit_notes', 'idx_credit_notes_company_sale_invoice');
    await queryRunner.query('DROP INDEX IF EXISTS idx_credit_notes_company_note_number_unique');
    await queryRunner.dropIndex('credit_notes', 'idx_credit_notes_company_id');
    await queryRunner.dropForeignKey('credit_notes', 'fk_credit_notes_customer_id');
    await queryRunner.dropForeignKey('credit_notes', 'fk_credit_notes_sale_invoice_id');
    await queryRunner.dropForeignKey('credit_notes', 'fk_credit_notes_company_id');
    await queryRunner.dropTable('credit_notes');
    await queryRunner.query('DROP TYPE IF EXISTS operation_type');
    await queryRunner.query('DROP TYPE IF EXISTS note_type');
  }
}
