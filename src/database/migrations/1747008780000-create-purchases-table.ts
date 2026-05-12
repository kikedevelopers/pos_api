import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 8 — Crea el tipo enum `purchase_status` y la tabla `purchases`.
 *
 * Espeja byte-por-byte `placepos/src/main/database/entities/Purchase.ts` con
 * adaptaciones multi-tenant:
 *
 *   - `company_id bigint NOT NULL` con FK a `companies`. Sin él, el listado
 *     `GET /purchases` filtraría compras de todos los tenants.
 *
 *   - `purchase_number` único per-company en lugar del UNIQUE GLOBAL de
 *     PlacePos (cada tenant tiene su propia secuencia de folios).
 *
 * --------------------------------------------------------------------------
 * Folio `purchase_number` — solución provisional sin TicketSetting
 * --------------------------------------------------------------------------
 *
 * PlacePos genera el folio leyendo y actualizando `TicketSetting` con
 * `ticket_type = 'PURCHASE'`. Esa tabla aún no existe en este API (Fase 10).
 *
 * Mientras tanto, el service usa `pg_advisory_xact_lock(hashtext('purchases_'
 * || company_id))` para serializar la generación de folios DENTRO de la
 * transacción de creación, leyendo `MAX(purchase_number)` y sumando 1. El
 * UNIQUE per-company funciona como defensa dura: si dos transacciones
 * concurrentes intentan insertar el mismo folio (race teórica), Postgres
 * rechaza con SQLSTATE 23505 → 409.
 *
 * El folio se serializa como texto `PUR-001`, `PUR-002`, etc. (espejo del
 * formato de PlacePos `formatNumber`).
 *
 * TODO(Fase 10): Reemplazar la generación con `UPDATE ticket_settings
 *                SET current_number = current_number + 1 ... RETURNING`
 *                cuando exista la tabla.
 *
 * --------------------------------------------------------------------------
 * Soft-delete
 * --------------------------------------------------------------------------
 *
 *   `is_deleted boolean` (NO `is_archived`) — espejo PlacePos. Las queries
 *   de listado filtran `is_deleted = false`. Las compras "anuladas" en este
 *   modelo NO son borrado físico, para preservar la auditoría financiera
 *   (un PurchasePayment histórico puede referenciarlas).
 *
 * --------------------------------------------------------------------------
 * `supplier_name` denormalizado
 * --------------------------------------------------------------------------
 *
 *   Snapshot del `legal_name` del supplier al momento de creación. Espejo
 *   PlacePos. Permite que el reporte histórico no cambie si el supplier
 *   cambia de razón social.
 */
export class CreatePurchasesTable1747008780000 implements MigrationInterface {
  name = 'CreatePurchasesTable1747008780000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum nativo `purchase_status`. PlacePos usa `PENDING` y
    //    `RECEIVED`. Conservamos esos dos valores.
    await queryRunner.query(`
      CREATE TYPE purchase_status AS ENUM ('PENDING', 'RECEIVED')
    `);

    // 2. Tabla purchases.
    await queryRunner.createTable(
      new Table({
        name: 'purchases',
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
              'Tenant al que pertenece la compra. Asignado por el service desde req.user.company_id; nunca aceptado del payload.',
          },
          {
            name: 'purchase_number',
            type: 'text',
            isNullable: false,
            comment:
              'Folio per-company (PUR-001, PUR-002, ...). Generado atómicamente dentro de la transacción del POST.',
          },
          {
            name: 'supplier_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'supplier_name',
            type: 'text',
            isNullable: false,
            comment:
              'Snapshot del legal_name del supplier al crear la compra. Inmutable; espejo PlacePos.',
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
            name: 'iva_total',
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
            name: 'notes',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'status',
            type: 'purchase_status',
            isNullable: false,
            enumName: 'purchase_status',
            default: `'PENDING'`,
          },
          {
            name: 'carrier_name',
            type: 'text',
            isNullable: true,
            comment: 'Transportadora que entregó la mercancía. Se llena al marcar como RECEIVED.',
          },
          {
            name: 'received_by',
            type: 'text',
            isNullable: true,
            comment: 'Nombre del receptor físico. Se llena al marcar como RECEIVED.',
          },
          {
            name: 'received_at',
            type: 'timestamptz',
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
              'Soft-delete convención PlacePos. is_deleted (NO is_archived) — espejo byte-por-byte de PlacePos.',
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
            name: 'chk_purchases_purchase_number_not_empty',
            expression: 'length(btrim(purchase_number)) > 0',
          },
          {
            name: 'chk_purchases_total_non_negative',
            expression: 'total >= 0',
          },
          {
            name: 'chk_purchases_subtotal_non_negative',
            expression: 'subtotal >= 0',
          },
          {
            name: 'chk_purchases_iva_total_non_negative',
            expression: 'iva_total >= 0',
          },
          {
            name: 'chk_purchases_received_consistency',
            expression: `
              status = 'PENDING'
              OR (
                received_at IS NOT NULL
                AND length(btrim(coalesce(carrier_name, ''))) > 0
                AND length(btrim(coalesce(received_by, ''))) > 0
              )
            `,
          },
        ],
      }),
      true,
    );

    // 3. FK a companies. RESTRICT — nunca borrar company con compras.
    await queryRunner.createForeignKey(
      'purchases',
      new TableForeignKey({
        name: 'fk_purchases_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. FK a suppliers. RESTRICT — no se puede borrar supplier con compras.
    await queryRunner.createForeignKey(
      'purchases',
      new TableForeignKey({
        name: 'fk_purchases_supplier_id',
        columnNames: ['supplier_id'],
        referencedTableName: 'suppliers',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 5. Índices.
    //    a) (company_id) — FK filter caliente.
    await queryRunner.createIndex(
      'purchases',
      new TableIndex({
        name: 'idx_purchases_company_id',
        columnNames: ['company_id'],
      }),
    );

    //    b) UNIQUE per-company (company_id, purchase_number).
    //       Defensa dura contra duplicación de folio (la transacción serializa
    //       con advisory lock, pero este UNIQUE es la red de seguridad).
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_purchases_company_number_unique
      ON purchases (company_id, purchase_number)
    `);

    //    c) (company_id, created_at DESC) WHERE is_deleted = false —
    //       feed cronológico que cubre `GET /purchases`.
    await queryRunner.query(`
      CREATE INDEX idx_purchases_company_active_created
      ON purchases (company_id, created_at DESC)
      WHERE is_deleted = false
    `);

    //    d) (company_id, supplier_id, created_at DESC) —
    //       cubre `GET /purchases/by-supplier/:supplierId` y reportes
    //       agregados por proveedor sin sequential scan.
    await queryRunner.query(`
      CREATE INDEX idx_purchases_company_supplier_created
      ON purchases (company_id, supplier_id, created_at DESC)
      WHERE is_deleted = false
    `);

    //    e) (company_id, status) WHERE is_deleted = false —
    //       filtra PENDING vs RECEIVED para reportes y dashboards.
    await queryRunner.query(`
      CREATE INDEX idx_purchases_company_status
      ON purchases (company_id, status)
      WHERE is_deleted = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchases_company_status');
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchases_company_supplier_created');
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchases_company_active_created');
    await queryRunner.query('DROP INDEX IF EXISTS idx_purchases_company_number_unique');
    await queryRunner.dropIndex('purchases', 'idx_purchases_company_id');
    await queryRunner.dropForeignKey('purchases', 'fk_purchases_supplier_id');
    await queryRunner.dropForeignKey('purchases', 'fk_purchases_company_id');
    await queryRunner.dropTable('purchases');
    await queryRunner.query('DROP TYPE IF EXISTS purchase_status');
  }
}
