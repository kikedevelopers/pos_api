import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 5 — Crea el tipo enum `cash_register_status` y la tabla `cash_registers`.
 *
 * Modelo de TURNOS (apertura/cierre) — divergencia respecto a PlacePos.
 *
 * --------------------------------------------------------------------------
 * Divergencia con PlacePos
 * --------------------------------------------------------------------------
 *
 * PlacePos modela `cash_register` como un row persistente por usuario con
 * `balance` corriente — NO hay concepto de turno. Cuando un usuario
 * autenticado opera, su único registro acumula movimientos.
 *
 * En el modelo cloud (este API) usamos TURNOS explícitos:
 *
 *   - Cada apertura crea un row con `status = 'open'` y `opening_balance`.
 *   - El cierre setea `status = 'closed'`, `closing_balance`,
 *     `expected_balance` (calculado), `difference` (cash - expected) y
 *     `closed_at`.
 *
 * Razón: en un entorno cloud multi-tenant compartido, los reportes diarios y
 * el cuadre de caja se hacen por turno cerrado, no por balance corriente. Es
 * el modelo estándar de POS en producción.
 *
 * Endpoints `/balance` y `/logs` de PlacePos siguen funcionando: `balance`
 * devuelve el balance del turno actualmente `open` (o un row sintético si no
 * hay turno abierto). `logs` lista CashRegisterLog filtrado por
 * `cash_register_id` del turno actual.
 *
 * --------------------------------------------------------------------------
 * Invariante crítica: UNA caja `open` por company
 * --------------------------------------------------------------------------
 *
 * Índice UNIQUE parcial: `(company_id) WHERE status = 'open'`. Garantiza a
 * nivel físico que dos cajas no puedan estar abiertas simultáneamente para
 * el mismo tenant. Un segundo `POST /cash-register/open` con caja abierta
 * dispara `unique_violation` → el action lo traduce a 409 con `code:
 * CASH_REGISTER_ALREADY_OPEN`.
 *
 * --------------------------------------------------------------------------
 * Apertura por user O employee — exactamente uno
 * --------------------------------------------------------------------------
 *
 * Una caja la abre un `User` (owner) O un `Employee`, no ambos. El CHECK
 * constraint enforza: exactamente uno de `opened_by_user_id` /
 * `opened_by_employee_id` debe ser NOT NULL.
 *
 * No declaramos FKs formales hacia `users`/`employees` aquí:
 *
 *   - Por simetría con el resto del API (`created_by_id` en banks/wallets
 *     tampoco tiene FK formal — es informacional).
 *   - Permite cerrar / consultar turnos históricos aunque el employee haya
 *     sido archivado.
 *
 * El service garantiza que el ID referencia un user/employee de la misma
 * company (lo obtiene de `req.user.user_id`).
 */
export class CreateCashRegistersTable1747008600000 implements MigrationInterface {
  name = 'CreateCashRegistersTable1747008600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum nativo.
    await queryRunner.query(`
      CREATE TYPE cash_register_status AS ENUM ('open', 'closed')
    `);

    // 2. Tabla cash_registers.
    await queryRunner.createTable(
      new Table({
        name: 'cash_registers',
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
            name: 'opened_by_user_id',
            type: 'bigint',
            isNullable: true,
            comment:
              'ID del User (owner) que abrió la caja. NULL si la abrió un Employee. CHECK enforza XOR con opened_by_employee_id.',
          },
          {
            name: 'opened_by_employee_id',
            type: 'bigint',
            isNullable: true,
            comment: 'ID del Employee que abrió la caja. NULL si la abrió un User.',
          },
          {
            name: 'opened_by_name',
            type: 'text',
            isNullable: true,
            comment: 'Snapshot del full_name del actor que abrió la caja.',
          },
          {
            name: 'opening_balance',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: false,
            default: '0',
            comment: 'Cash físico al abrir el turno (conteo manual del usuario).',
          },
          {
            name: 'closing_balance',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: true,
            comment: 'Cash físico al cerrar (conteo manual). NULL hasta el cierre.',
          },
          {
            name: 'expected_balance',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: true,
            comment:
              'Balance esperado al cierre = opening + IN - OUT (calculado por la action). NULL hasta el cierre.',
          },
          {
            name: 'difference',
            type: 'numeric',
            precision: 15,
            scale: 2,
            isNullable: true,
            comment:
              'difference = closing_balance - expected_balance. Positivo = sobrante, negativo = faltante. NULL hasta el cierre.',
          },
          {
            name: 'status',
            type: 'cash_register_status',
            isNullable: false,
            enumName: 'cash_register_status',
            default: `'open'`,
          },
          {
            name: 'opened_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
          {
            name: 'closed_at',
            type: 'timestamptz',
            isNullable: true,
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
            // XOR opened_by_*: exactamente uno NOT NULL.
            name: 'chk_cash_registers_opener_xor',
            expression: `
              (opened_by_user_id IS NOT NULL AND opened_by_employee_id IS NULL)
              OR (opened_by_user_id IS NULL AND opened_by_employee_id IS NOT NULL)
            `,
          },
          {
            // Cuando status = 'closed', closing/expected/closed_at son NOT NULL.
            name: 'chk_cash_registers_closed_complete',
            expression: `
              status = 'open'
              OR (
                closing_balance IS NOT NULL
                AND expected_balance IS NOT NULL
                AND difference IS NOT NULL
                AND closed_at IS NOT NULL
              )
            `,
          },
          {
            name: 'chk_cash_registers_opening_balance_non_negative',
            expression: 'opening_balance >= 0',
          },
        ],
      }),
      true,
    );

    // 3. FK a companies.
    await queryRunner.createForeignKey(
      'cash_registers',
      new TableForeignKey({
        name: 'fk_cash_registers_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. Índice por company_id.
    await queryRunner.createIndex(
      'cash_registers',
      new TableIndex({
        name: 'idx_cash_registers_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 5. UNIQUE parcial: una sola caja `open` por company.
    //    Es la garantía DURA de la invariante. Si el service intenta abrir una
    //    segunda caja, Postgres rechaza con SQLSTATE 23505 y la action lo
    //    traduce a 409.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_cash_registers_one_open_per_company
      ON cash_registers (company_id)
      WHERE status = 'open'
    `);

    // 6. Índice histórico por (company_id, opened_at DESC). Cubre el listado
    //    histórico de turnos cerrados.
    await queryRunner.query(`
      CREATE INDEX idx_cash_registers_company_opened_at
      ON cash_registers (company_id, opened_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_cash_registers_company_opened_at');
    await queryRunner.query('DROP INDEX IF EXISTS idx_cash_registers_one_open_per_company');
    await queryRunner.dropIndex('cash_registers', 'idx_cash_registers_company_id');
    await queryRunner.dropForeignKey('cash_registers', 'fk_cash_registers_company_id');
    await queryRunner.dropTable('cash_registers');
    await queryRunner.query('DROP TYPE IF EXISTS cash_register_status');
  }
}
