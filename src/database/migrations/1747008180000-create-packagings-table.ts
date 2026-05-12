import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 3 — Crea la tabla `packagings` (empaques / unidades de envase).
 *
 * Contexto del dominio:
 *
 *   Un `Packaging` describe un envase ("caja de 12 latas", "bolsa de 5 kg")
 *   asociable a un `Product` para que el módulo de compras razone por unidad
 *   física en vez de unidad lógica. PlacePos lo mantiene como tabla simple:
 *   `name` + `value` (cantidad de unidades dentro del empaque).
 *
 * --------------------------------------------------------------------------
 * Divergencias intencionales vs PlacePos local
 * --------------------------------------------------------------------------
 *
 *  1. **Multi-tenancy**: PlacePos local es single-tenant; el API CLOUD
 *     añade `company_id NOT NULL` (FK a `companies`). Todas las queries
 *     filtran por `company_id`. La UNIQUEness pasa de global a per-company
 *     (`UNIQUE (company_id, name)`).
 *
 *  2. **`value` con precisión 4**: PlacePos lo persiste como `numeric(15,2)`;
 *     aquí lo elevamos a `numeric(15,4)` (renombrado `unit_value` en la
 *     entidad pero columna sigue siendo `value` por paridad de contrato HTTP
 *     en la respuesta — ver mapper en el controller). Razón: §2.5 de
 *     CLAUDE.md indica que las CANTIDADES van con 4 decimales. Un empaque
 *     puede contener 0.5 kg, 1.25 L, etc.
 *
 * --------------------------------------------------------------------------
 * Índices
 * --------------------------------------------------------------------------
 *
 *  - `idx_packagings_company_id` — FK necesaria para ON DELETE RESTRICT.
 *  - `idx_packagings_company_active` — listado activo por tenant (parcial).
 *  - `idx_packagings_company_name_unique` — UNIQUE per-company.
 *    PARCIAL: solo aplica a registros activos. Permite reciclar el nombre
 *    de un empaque archivado.
 */
export class CreatePackagingsTable1747008180000 implements MigrationInterface {
  name = 'CreatePackagingsTable1747008180000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'packagings',
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
              'Tenant al que pertenece el empaque. Asignado por el service desde req.user.company_id.',
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'value',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: false,
            default: '0',
            comment: 'Cantidad de unidades dentro del empaque (0.5, 12, 100, ...).',
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment:
              'Soft-delete convención PlacePos. Listados activos filtran is_archived = false.',
          },
          {
            name: 'created_by',
            type: 'text',
            isNullable: true,
            comment: 'Snapshot del full_name del actor que creó el empaque.',
          },
          {
            name: 'created_by_id',
            type: 'bigint',
            isNullable: true,
            comment: 'ID del usuario creador. Sin FK formal (informacional).',
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
            name: 'chk_packagings_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
          {
            name: 'chk_packagings_value_non_negative',
            expression: 'value >= 0',
          },
        ],
      }),
      true,
    );

    // FK a companies. ON DELETE RESTRICT: nunca borrar company con empaques.
    await queryRunner.createForeignKey(
      'packagings',
      new TableForeignKey({
        name: 'fk_packagings_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índice en company_id (FK + filtro multi-tenant en TODAS las queries).
    await queryRunner.createIndex(
      'packagings',
      new TableIndex({
        name: 'idx_packagings_company_id',
        columnNames: ['company_id'],
      }),
    );

    // Listado activo por tenant — endpoint GET /packagings.
    await queryRunner.query(`
      CREATE INDEX idx_packagings_company_active
      ON packagings (company_id)
      WHERE is_archived = false
    `);

    // UNIQUE per-company sobre `name` (solo activos). El UNIQUE PARCIAL
    // permite que un empaque archivado libere el nombre para que un nuevo
    // empaque activo de la misma company lo reutilice. Es coherente con
    // PlacePos: archivar empuja el dato fuera del catálogo operativo.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_packagings_company_name_unique
      ON packagings (company_id, lower(btrim(name)))
      WHERE is_archived = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_packagings_company_name_unique');
    await queryRunner.query('DROP INDEX IF EXISTS idx_packagings_company_active');
    await queryRunner.dropIndex('packagings', 'idx_packagings_company_id');
    await queryRunner.dropForeignKey('packagings', 'fk_packagings_company_id');
    await queryRunner.dropTable('packagings');
  }
}
