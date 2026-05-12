import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 5 — Crea los tipos enum `movement_type` / `movement_concept` y la
 * tabla `financial_movements`.
 *
 * Tabla de AUDITORÍA inmutable: cada vez que el dinero cambia de cuenta
 * (venta, compra, transferencia, gasto, ingreso/egreso manual de caja, saldo
 * inicial), generamos un row aquí. Los reportes financieros se construyen
 * sobre esta tabla, NO sobre los balances corrientes de banks/wallets
 * (defensa contra desincronización).
 *
 * Espeja `placepos/src/main/database/entities/FinancialMovement.ts` con
 * adaptaciones multi-tenant.
 *
 * --------------------------------------------------------------------------
 * Modelo de "dirección" — equivalencia entre PlacePos y el prompt
 * --------------------------------------------------------------------------
 *
 * PlacePos usa `movement_type` enum (`INCOME` | `EXPENSE` | `TRANSFER`). El
 * prompt habla de `direction` (`credit` | `debit`). Mantenemos los nombres
 * de PlacePos para preservar paridad byte-por-byte del payload — `INCOME`
 * equivale a "crédito" (entra dinero a la cuenta destination) y `EXPENSE` a
 * "débito" (sale dinero de la cuenta source). `TRANSFER` se genera por par
 * (dos rows) en `accounts.routes.ts` cuando se hace un traslado entre
 * cuentas distintas. Mantener esto preserva el contrato HTTP.
 *
 * --------------------------------------------------------------------------
 * Endpoint NO expone POST
 * --------------------------------------------------------------------------
 *
 * `financial-movements` solo expone GET con filtros. Los rows se generan
 * INTERNAMENTE desde otras actions (banks.create, accounts.transfer,
 * sales.*, etc.) en la misma transacción que el cambio de balance. Inyectar
 * un row directo desde el cliente rompería la conciliación.
 */
export class CreateFinancialMovementsTable1747008720000 implements MigrationInterface {
  name = 'CreateFinancialMovementsTable1747008720000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipos enum nativos. Coinciden EXACTAMENTE con
    //    `placepos/src/main/database/enums/MovementType.ts` y
    //    `MovementConcept.ts` para preservar el shape del payload.
    await queryRunner.query(`
      CREATE TYPE movement_type AS ENUM ('INCOME', 'EXPENSE', 'TRANSFER')
    `);
    await queryRunner.query(`
      CREATE TYPE movement_concept AS ENUM (
        'SALE',
        'PURCHASE',
        'EXPENSE',
        'TRANSFER',
        'INITIAL_BALANCE',
        'ADJUSTMENT',
        'CREDIT_PAYMENT',
        'CREDIT_NOTE_REFUND'
      )
    `);

    // 2. Tabla.
    await queryRunner.createTable(
      new Table({
        name: 'financial_movements',
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
            name: 'amount',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'movement_type',
            type: 'movement_type',
            isNullable: false,
            enumName: 'movement_type',
          },
          {
            name: 'concept',
            type: 'movement_concept',
            isNullable: false,
            enumName: 'movement_concept',
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'source_type',
            type: 'text',
            isNullable: true,
            comment: `'bank' | 'wallet' | 'cash_register' | 'external'. Cuenta de origen (donde sale el dinero). NULL para INCOME sin origen rastreado.`,
          },
          {
            name: 'source_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'destination_type',
            type: 'text',
            isNullable: true,
            comment: `'bank' | 'wallet' | 'cash_register' | 'external'. Cuenta de destino. NULL para EXPENSE sin destino rastreado.`,
          },
          {
            name: 'destination_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'reference_code',
            type: 'text',
            isNullable: true,
            comment:
              'Código libre para correlacionar con la operación origen (ticket_number, transfer_id, etc.).',
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
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
        checks: [
          {
            name: 'chk_financial_movements_amount_positive',
            expression: 'amount > 0',
          },
          {
            // source_type/destination_type, si vienen, sólo pueden tener ciertos valores.
            name: 'chk_financial_movements_account_types',
            expression: `
              (source_type IS NULL OR source_type IN ('bank', 'wallet', 'cash_register', 'external'))
              AND (destination_type IS NULL OR destination_type IN ('bank', 'wallet', 'cash_register', 'external'))
            `,
          },
          {
            // source_*: coherencia de NULL — si type es NULL, id también; y viceversa.
            name: 'chk_financial_movements_source_consistency',
            expression: `
              (source_type IS NULL AND source_id IS NULL)
              OR (source_type IS NOT NULL AND source_id IS NOT NULL)
            `,
          },
          {
            name: 'chk_financial_movements_destination_consistency',
            expression: `
              (destination_type IS NULL AND destination_id IS NULL)
              OR (destination_type IS NOT NULL AND destination_id IS NOT NULL)
            `,
          },
          {
            // Al menos uno de source/destination debe estar presente —
            // un movimiento sin origen NI destino es ruido.
            name: 'chk_financial_movements_has_endpoint',
            expression: 'source_type IS NOT NULL OR destination_type IS NOT NULL',
          },
        ],
      }),
      true,
    );

    // 3. FK a companies.
    await queryRunner.createForeignKey(
      'financial_movements',
      new TableForeignKey({
        name: 'fk_financial_movements_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. Índices.
    //    a) (company_id, created_at DESC) — feed cronológico (reportes).
    await queryRunner.query(`
      CREATE INDEX idx_financial_movements_company_created
      ON financial_movements (company_id, created_at DESC)
    `);

    //    b) (company_id, source_type, source_id) — listar movimientos donde
    //       una cuenta fue origen (filtro principal del endpoint GET).
    await queryRunner.createIndex(
      'financial_movements',
      new TableIndex({
        name: 'idx_financial_movements_company_source',
        columnNames: ['company_id', 'source_type', 'source_id'],
      }),
    );

    //    c) (company_id, destination_type, destination_id) — idem destino.
    await queryRunner.createIndex(
      'financial_movements',
      new TableIndex({
        name: 'idx_financial_movements_company_destination',
        columnNames: ['company_id', 'destination_type', 'destination_id'],
      }),
    );

    //    d) (company_id, concept) — agrupaciones por concepto en reportes.
    await queryRunner.createIndex(
      'financial_movements',
      new TableIndex({
        name: 'idx_financial_movements_company_concept',
        columnNames: ['company_id', 'concept'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('financial_movements', 'idx_financial_movements_company_concept');
    await queryRunner.dropIndex(
      'financial_movements',
      'idx_financial_movements_company_destination',
    );
    await queryRunner.dropIndex('financial_movements', 'idx_financial_movements_company_source');
    await queryRunner.query('DROP INDEX IF EXISTS idx_financial_movements_company_created');
    await queryRunner.dropForeignKey('financial_movements', 'fk_financial_movements_company_id');
    await queryRunner.dropTable('financial_movements');
    await queryRunner.query('DROP TYPE IF EXISTS movement_concept');
    await queryRunner.query('DROP TYPE IF EXISTS movement_type');
  }
}
