import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 4 — Crea la tabla `suppliers`.
 *
 * Contexto del dominio:
 *
 *   `Supplier` representa al proveedor de la company. PlacePos lo modela con
 *   `legal_name` (razón social) + `broker` (representante/contacto) +
 *   `accumulated_debt` (lo que la company le debe) + `credit_balance` (saldo
 *   a favor de la company). Se replica byte-por-byte.
 *
 * --------------------------------------------------------------------------
 * Divergencias intencionales respecto al prompt de Fase 4
 * --------------------------------------------------------------------------
 *
 *   - El prompt pedía `name + debt`. PlacePos usa `legal_name + broker +
 *     accumulated_debt + credit_balance`. Respetamos PlacePos (CLAUDE.md §2.1
 *     — paridad byte-por-byte). Renombrar `accumulated_debt` a `debt` rompería
 *     el frontend Electron cuando opera en modo CLOUD.
 *
 *   - El prompt pedía `document_number`. PlacePos usa `doc_number`. Respetamos
 *     PlacePos.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   - `company_id bigint NOT NULL` + FK a companies + índice.
 *   - Toda query DEBE filtrar por company_id.
 *
 * --------------------------------------------------------------------------
 * Semántica financiera de las dos columnas signed-zero
 * --------------------------------------------------------------------------
 *
 *   `accumulated_debt` numeric(15,2) >= 0:
 *     Lo que la company le debe al proveedor. Aumenta con compras a crédito;
 *     decrece con pagos. Mutación EXCLUSIVA en Fase 8 (purchases) y Fase 9
 *     (purchase_payments).
 *
 *   `credit_balance` numeric(15,2) >= 0:
 *     Saldo a favor de la company (anticipos, devoluciones pendientes,
 *     notas de crédito del proveedor). Mutación EXCLUSIVA en Fase 8 y 9.
 *
 *   El create en Fase 4 inicializa ambos a 0. El update NO permite tocarlos
 *   desde el DTO público — defensa en profundidad anti-bug. CHECK constraints
 *   garantizan no-negatividad.
 *
 * --------------------------------------------------------------------------
 * `created_by` / `created_by_id` — sin FK formal (Opción A)
 * --------------------------------------------------------------------------
 *
 *   Snapshot del full_name + id sin FK formal. Mismo patrón que `employees` y
 *   `customers`.
 */
export class CreateSuppliersTable1747008420000 implements MigrationInterface {
  name = 'CreateSuppliersTable1747008420000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'suppliers',
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
              'Tenant al que pertenece el supplier. Asignado desde req.user.company_id; nunca aceptado del payload.',
          },
          {
            name: 'legal_name',
            type: 'text',
            isNullable: false,
            comment: 'Razón social del proveedor.',
          },
          {
            name: 'broker',
            type: 'text',
            isNullable: true,
            comment: 'Representante/contacto comercial del proveedor (no es un user del sistema).',
          },
          {
            name: 'address',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'phone',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'doc_number',
            type: 'text',
            isNullable: true,
            comment:
              'Documento fiscal del proveedor (RIF/NIT/CUIT/RFC). Formato libre. Sin UNIQUE.',
          },
          {
            name: 'email',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'accumulated_debt',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Cuentas por pagar acumuladas con el proveedor. Mutación solo en fases 8 y 9.',
          },
          {
            name: 'credit_balance',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment:
              'Saldo a favor de la company (anticipos, devoluciones, etc.). Mutación solo en fases 8 y 9.',
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment: 'Soft-delete convención PlacePos. Filtro implícito en listados activos.',
          },
          {
            name: 'created_by',
            type: 'text',
            isNullable: true,
            comment:
              'Snapshot del full_name del actor que creó el supplier. Texto congelado, sin join.',
          },
          {
            name: 'created_by_id',
            type: 'bigint',
            isNullable: true,
            comment: 'ID del usuario o empleado creador. Sin FK formal (informacional).',
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
            name: 'chk_suppliers_legal_name_not_empty',
            expression: 'length(btrim(legal_name)) > 0',
          },
          {
            name: 'chk_suppliers_accumulated_debt_non_negative',
            expression: 'accumulated_debt >= 0',
          },
          {
            name: 'chk_suppliers_credit_balance_non_negative',
            expression: 'credit_balance >= 0',
          },
        ],
      }),
      true,
    );

    // FK a companies. ON DELETE RESTRICT: no se borra company con suppliers.
    await queryRunner.createForeignKey(
      'suppliers',
      new TableForeignKey({
        name: 'fk_suppliers_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índice por company_id (FK + filtros).
    await queryRunner.createIndex(
      'suppliers',
      new TableIndex({
        name: 'idx_suppliers_company_id',
        columnNames: ['company_id'],
      }),
    );

    // Índice compuesto parcial (company_id, created_at DESC) WHERE is_archived = false.
    // Cubre el endpoint `GET /suppliers` (lista activos por fecha desc).
    await queryRunner.query(`
      CREATE INDEX idx_suppliers_company_active
      ON suppliers (company_id, created_at DESC)
      WHERE is_archived = false
    `);

    // Índice parcial sobre doc_number — búsqueda admin por RIF/NIT.
    await queryRunner.query(`
      CREATE INDEX idx_suppliers_company_doc_number
      ON suppliers (company_id, doc_number)
      WHERE doc_number IS NOT NULL
    `);

    // Índice por (company_id, lower(legal_name)) para búsqueda case-insensitive
    // por razón social.
    await queryRunner.query(`
      CREATE INDEX idx_suppliers_company_legal_name_lower
      ON suppliers (company_id, lower(legal_name))
      WHERE is_archived = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_suppliers_company_legal_name_lower');
    await queryRunner.query('DROP INDEX IF EXISTS idx_suppliers_company_doc_number');
    await queryRunner.query('DROP INDEX IF EXISTS idx_suppliers_company_active');
    await queryRunner.dropIndex('suppliers', 'idx_suppliers_company_id');
    await queryRunner.dropForeignKey('suppliers', 'fk_suppliers_company_id');
    await queryRunner.dropTable('suppliers');
  }
}
