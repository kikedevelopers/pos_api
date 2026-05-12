import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 4 — Crea el tipo enum `person_type` y la tabla `customers`.
 *
 * Contexto del dominio:
 *
 *   `Customer` representa al cliente final de la company. PlacePos lo modela
 *   con un único campo `name` (no se separa name/lastname) y un discriminador
 *   `person_type` ∈ {INDIVIDUAL, COMPANY}. Se replica byte-por-byte.
 *
 * --------------------------------------------------------------------------
 * Divergencias intencionales respecto al prompt de Fase 4
 * --------------------------------------------------------------------------
 *
 *   - El prompt pedía `name + lastname + debt + credit`. PlacePos modela
 *     `name + balance` (un único campo signed: positivo = la company le debe
 *     al cliente, negativo = el cliente le debe a la company). Respetamos
 *     el contrato PlacePos (CLAUDE.md §2.1) para no romper paridad con el
 *     frontend Electron. La lógica `debt/credit` se puede derivar en lectura
 *     a partir del signo de `balance` cuando alguna fase futura lo requiera.
 *
 *   - El prompt pedía `document_number`. PlacePos usa `doc_number`. Respetamos
 *     PlacePos.
 *
 *   - El prompt pedía `is_archived`. PlacePos NO archiva customers (no expone
 *     `PUT /:id/archive` ni filtra por `is_archived`). Añadimos `is_archived`
 *     a la tabla como capacidad cloud no-breaking (defecto FALSE), pero
 *     reservamos el endpoint `PUT /customers/:id/archive` como extensión
 *     cloud sin contrapartida en PlacePos. El frontend Electron lo ignora.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   - `company_id bigint NOT NULL` + FK a companies + índice.
 *   - Toda query DEBE filtrar por company_id (responsabilidad del service).
 *   - Sin UNIQUE compuesto sobre doc_number: dos clientes pueden compartir RIF
 *     en la práctica (errores de captura, RIFs corporativos repetidos en
 *     sucursales). Se indexa parcialmente para búsquedas, no se enforza.
 *
 * --------------------------------------------------------------------------
 * `balance` — semántica financiera
 * --------------------------------------------------------------------------
 *
 *   numeric(15,2) con DEFAULT 0. SIGNED:
 *     - balance > 0  ⇒ la company le debe dinero al cliente (anticipos,
 *       devoluciones pendientes, notas de crédito a favor del cliente).
 *     - balance < 0  ⇒ el cliente le debe dinero a la company (ventas a
 *       crédito impagas).
 *
 *   Su MUTACIÓN ocurre EXCLUSIVAMENTE en fases 6 (ventas/créditos), 8 (notas)
 *   y 9 (pagos). En Fase 4 el create lo inicializa a 0; el update NO permite
 *   tocarlo desde el DTO público.
 *
 * --------------------------------------------------------------------------
 * `created_by` / `created_by_id` — sin FK formal (Opción A)
 * --------------------------------------------------------------------------
 *
 *   Se preserva el snapshot del full_name del actor + su id. Sin FK formal —
 *   mismo patrón que `employees` (ver migración 1747008120000).
 */
export class CreateCustomersTable1747008360000 implements MigrationInterface {
  name = 'CreateCustomersTable1747008360000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum nativo de Postgres. Coincide con el `enumName` de la entidad.
    await queryRunner.query(`
      CREATE TYPE person_type AS ENUM ('INDIVIDUAL', 'COMPANY')
    `);

    // 2. Tabla customers.
    await queryRunner.createTable(
      new Table({
        name: 'customers',
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
              'Tenant al que pertenece el cliente. Asignado desde req.user.company_id; nunca aceptado del payload.',
          },
          {
            name: 'person_type',
            type: 'person_type',
            isNullable: false,
            default: `'INDIVIDUAL'`,
            enumName: 'person_type',
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'email',
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
              'Documento fiscal/identificación. Formato libre. Sin UNIQUE para tolerar duplicados legítimos.',
          },
          {
            name: 'address',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'balance',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment:
              'SIGNED. >0: la company le debe al cliente. <0: el cliente le debe a la company. Mutación solo en fases 6/8/9.',
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment:
              'Extensión cloud — PlacePos local no archiva customers. Filtro implícito en listados activos.',
          },
          {
            name: 'created_by',
            type: 'text',
            isNullable: true,
            comment:
              'Snapshot del full_name del actor que creó el cliente. Texto congelado, sin join.',
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
            name: 'chk_customers_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
        ],
      }),
      true,
    );

    // 3. FK a companies. ON DELETE RESTRICT: no se borra company con customers.
    await queryRunner.createForeignKey(
      'customers',
      new TableForeignKey({
        name: 'fk_customers_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. Índice por company_id (toda query autenticada filtra por este campo;
    //    además, el RESTRICT on delete necesita el índice para no degradar a
    //    seq scan).
    await queryRunner.createIndex(
      'customers',
      new TableIndex({
        name: 'idx_customers_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 5. Índice compuesto parcial (company_id, created_at DESC) WHERE is_archived = false.
    //    Justificación: el endpoint `GET /customers` lista clientes activos
    //    ordenados por created_at DESC. El índice parcial reduce tamaño al
    //    excluir registros archivados (que solo se consultan en reportes).
    await queryRunner.query(`
      CREATE INDEX idx_customers_company_active
      ON customers (company_id, created_at DESC)
      WHERE is_archived = false
    `);

    // 6. Índice parcial sobre doc_number — soporta búsquedas administrativas
    //    sin penalizar filas sin documento (que serán mayoría en INDIVIDUAL).
    await queryRunner.query(`
      CREATE INDEX idx_customers_company_doc_number
      ON customers (company_id, doc_number)
      WHERE doc_number IS NOT NULL
    `);

    // 7. Índice trigram-like para búsqueda por nombre/teléfono. No usamos
    //    pg_trgm (requiere extensión opcional); un índice B-tree por
    //    (company_id, lower(name)) cubre filtros prefijales. Si en el futuro
    //    la búsqueda full-text se vuelve crítica, migrar a pg_trgm con
    //    extensión separada.
    await queryRunner.query(`
      CREATE INDEX idx_customers_company_name_lower
      ON customers (company_id, lower(name))
      WHERE is_archived = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_customers_company_name_lower');
    await queryRunner.query('DROP INDEX IF EXISTS idx_customers_company_doc_number');
    await queryRunner.query('DROP INDEX IF EXISTS idx_customers_company_active');
    await queryRunner.dropIndex('customers', 'idx_customers_company_id');
    await queryRunner.dropForeignKey('customers', 'fk_customers_company_id');
    await queryRunner.dropTable('customers');
    await queryRunner.query('DROP TYPE IF EXISTS person_type');
  }
}
