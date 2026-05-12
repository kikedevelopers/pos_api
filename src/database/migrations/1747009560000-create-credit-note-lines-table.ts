import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 7 — Crea la tabla `credit_note_lines`.
 *
 * Espejo de `placepos/src/main/database/entities/CreditNoteLine.ts` con
 * `company_id` denormalizado.
 *
 * --------------------------------------------------------------------------
 * Cuándo se generan líneas
 * --------------------------------------------------------------------------
 *
 *   - `FULL_VOID`: típicamente NO se generan líneas — la nota anula toda la
 *     venta y el total se replica de `sale.total`. PlacePos puede optar por
 *     copiar las líneas originales (snapshot) o no. Permitimos AMBAS
 *     opciones; el service decide.
 *
 *   - `PARTIAL_VOID`: una línea por cada producto / cantidad anulado.
 *     `original_line_id` referencia la línea de venta original
 *     (`sale_invoice_lines.id`) para trazabilidad.
 *
 *   - `ADDITION` (nota débito): una línea por cargo agregado. Puede
 *     referenciar un producto si el cargo se asocia (servicio, recargo) o
 *     ser un concepto libre (en cuyo caso `product_id` apunta a un producto
 *     genérico "Recargo" o similar).
 *
 * --------------------------------------------------------------------------
 * Precisión
 * --------------------------------------------------------------------------
 *
 *   Cantidades `numeric(15,4)`. Montos `numeric(15,2)`. CLAUDE.md §2.5.
 */
export class CreateCreditNoteLinesTable1747009560000 implements MigrationInterface {
  name = 'CreateCreditNoteLinesTable1747009560000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'credit_note_lines',
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
            comment: 'Denormalizado. Coincide con credit_note.company_id; impuesto por el service.',
          },
          {
            name: 'credit_note_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'original_line_id',
            type: 'bigint',
            isNullable: true,
            comment:
              'sale_invoice_lines.id que se está corrigiendo. NULL para ADDITION u operaciones libres.',
          },
          {
            name: 'product_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Snapshot del producto al momento de la corrección.',
          },
          {
            name: 'packaging_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'description',
            type: 'text',
            isNullable: false,
            comment: 'Snapshot del nombre.',
          },
          {
            name: 'quantity',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
          },
          {
            name: 'unit_price',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Precio unitario (snapshot de la venta original o del cargo).',
          },
          {
            name: 'unit_cost',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
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
            name: 'iva_percentage',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
          },
          {
            name: 'iva_amount',
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
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
        checks: [
          {
            name: 'chk_credit_note_lines_quantity_positive',
            expression: 'quantity > 0',
          },
          {
            name: 'chk_credit_note_lines_unit_price_non_negative',
            expression: 'unit_price >= 0',
          },
          {
            name: 'chk_credit_note_lines_unit_cost_non_negative',
            expression: 'unit_cost >= 0',
          },
          {
            name: 'chk_credit_note_lines_subtotal_non_negative',
            expression: 'subtotal >= 0',
          },
          {
            name: 'chk_credit_note_lines_iva_percentage_valid',
            expression: 'iva_percentage >= 0 AND iva_percentage <= 100',
          },
          {
            name: 'chk_credit_note_lines_iva_amount_non_negative',
            expression: 'iva_amount >= 0',
          },
          {
            name: 'chk_credit_note_lines_total_non_negative',
            expression: 'total >= 0',
          },
          {
            name: 'chk_credit_note_lines_description_not_empty',
            expression: 'length(btrim(description)) > 0',
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'credit_note_lines',
      new TableForeignKey({
        name: 'fk_credit_note_lines_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a credit_notes. CASCADE — limpiar líneas si se borra físicamente la nota.
    await queryRunner.createForeignKey(
      'credit_note_lines',
      new TableForeignKey({
        name: 'fk_credit_note_lines_credit_note_id',
        columnNames: ['credit_note_id'],
        referencedTableName: 'credit_notes',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a sale_invoice_lines (nullable). SET NULL si se borra la línea
    // original — preservamos la línea de la nota para auditoría.
    await queryRunner.createForeignKey(
      'credit_note_lines',
      new TableForeignKey({
        name: 'fk_credit_note_lines_original_line_id',
        columnNames: ['original_line_id'],
        referencedTableName: 'sale_invoice_lines',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a products. RESTRICT — no se borra producto con historial de notas.
    await queryRunner.createForeignKey(
      'credit_note_lines',
      new TableForeignKey({
        name: 'fk_credit_note_lines_product_id',
        columnNames: ['product_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a packagings (nullable). RESTRICT.
    await queryRunner.createForeignKey(
      'credit_note_lines',
      new TableForeignKey({
        name: 'fk_credit_note_lines_packaging_id',
        columnNames: ['packaging_id'],
        referencedTableName: 'packagings',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    // a) FK credit_note_id — listar líneas de una nota.
    await queryRunner.createIndex(
      'credit_note_lines',
      new TableIndex({
        name: 'idx_credit_note_lines_credit_note_id',
        columnNames: ['credit_note_id'],
      }),
    );

    // b) (company_id, original_line_id) — sumar cantidades anuladas por línea
    //    original (validación PARTIAL_VOID: no exceder qty original).
    await queryRunner.query(`
      CREATE INDEX idx_credit_note_lines_company_original_line
      ON credit_note_lines (company_id, original_line_id)
      WHERE original_line_id IS NOT NULL
    `);

    // c) (company_id, product_id, created_at DESC) — histórico de devoluciones
    //    por producto (analytics).
    await queryRunner.query(`
      CREATE INDEX idx_credit_note_lines_company_product_created
      ON credit_note_lines (company_id, product_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_credit_note_lines_company_product_created');
    await queryRunner.query('DROP INDEX IF EXISTS idx_credit_note_lines_company_original_line');
    await queryRunner.dropIndex('credit_note_lines', 'idx_credit_note_lines_credit_note_id');
    await queryRunner.dropForeignKey('credit_note_lines', 'fk_credit_note_lines_packaging_id');
    await queryRunner.dropForeignKey('credit_note_lines', 'fk_credit_note_lines_product_id');
    await queryRunner.dropForeignKey('credit_note_lines', 'fk_credit_note_lines_original_line_id');
    await queryRunner.dropForeignKey('credit_note_lines', 'fk_credit_note_lines_credit_note_id');
    await queryRunner.dropForeignKey('credit_note_lines', 'fk_credit_note_lines_company_id');
    await queryRunner.dropTable('credit_note_lines');
  }
}
