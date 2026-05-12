import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableIndex } from 'typeorm';

/**
 * Fase 0 — Crea la tabla `companies` (el tenant raíz del sistema multi-tenant).
 *
 * Diferencias vs PlacePos local (documentadas como divergencias intencionales):
 *
 *  - PlacePos define `companies.owner_id` (FK a users) con la relación
 *    `Company -> User` apuntando al dueño. Aquí invertimos la relación:
 *    `users.company_id` apunta a la company, y el dueño se identifica por
 *    `users.type = 'owner'`. Razón: evita el problema "chicken-and-egg" del
 *    `POST /auth/register` (no podemos crear Company con FK a un User que
 *    todavía no existe, ni viceversa, sin recurrir a deferred constraints).
 *
 *  - `break_even_period_days` lo dejamos como `integer` (no `smallint` como
 *    en PlacePos). El espacio extra es negligible y simplifica el tipado en
 *    TypeScript (siempre `number`).
 *
 * Decisión sobre unicidad de `document_number`:
 *  No se enforce UNIQUE global porque:
 *    (a) Formatos varían por país (RIF venezolano, NIT colombiano, CUIT
 *        argentino, RFC mexicano). Validar normalización aquí es prematuro.
 *    (b) Puede ser NULL en registro inicial.
 *    (c) Dos negocios distintos podrían compartir RIF en escenarios reales
 *        (sucursales separadas registradas como tenants distintos).
 *  Sí indexamos parcialmente para soportar búsquedas administrativas.
 */
export class CreateCompaniesTable1747008000000 implements MigrationInterface {
  name = 'CreateCompaniesTable1747008000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'companies',
        columns: [
          {
            name: 'id',
            type: 'bigserial',
            isPrimary: true,
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'document_number',
            type: 'text',
            isNullable: true,
            comment:
              'Identificador fiscal del negocio (RIF/NIT/CUIT/RFC). Formato libre, sin UNIQUE global.',
          },
          {
            name: 'balance',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'address',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'email',
            type: 'text',
            isNullable: true,
            comment:
              'Email de contacto del negocio. Distinto del email del owner (que vive en users.email).',
          },
          {
            name: 'phone_number',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'break_even_amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
          },
          {
            name: 'break_even_period_days',
            type: 'integer',
            isNullable: false,
            default: 30,
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
            name: 'chk_companies_balance_finite',
            expression: 'balance IS NOT NULL',
          },
          {
            name: 'chk_companies_break_even_period_positive',
            expression: 'break_even_period_days > 0',
          },
          {
            name: 'chk_companies_break_even_amount_non_negative',
            expression: 'break_even_amount >= 0',
          },
        ],
      }),
      true,
    );

    // Índice por nombre — soporta búsquedas en panel admin futuro.
    await queryRunner.createIndex(
      'companies',
      new TableIndex({
        name: 'idx_companies_name',
        columnNames: ['name'],
      }),
    );

    // Índice parcial por document_number — solo filas con documento.
    // Justificación: el panel admin filtra por RIF/NIT cuando existe; si es
    // NULL no tiene sentido indexar (ahorra espacio en árbol B-tree).
    await queryRunner.query(`
      CREATE INDEX idx_companies_document_number
      ON companies (document_number)
      WHERE document_number IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_companies_document_number');
    await queryRunner.dropIndex('companies', 'idx_companies_name');
    await queryRunner.dropTable('companies');
  }
}
