import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea las tablas del módulo Kanban colaborativo (AISLADO): `kanban_boards`
 * (tableros) y `kanban_cards` (tarjetas). Multi-tenant por `company_id`.
 *
 * Diseño para reordenamiento rápido y concurrente:
 *   - `position double precision` (rank fraccionado): mover = un solo UPDATE
 *     por punto medio, sin renumerar el resto.
 *   - Índices `(company_id, position)` y `(company_id, board_id, position)`
 *     para leer ordenado con un escaneo de índice.
 *   - Índices únicos parciales de idempotencia `(company_id, client_operation_id)`.
 *   - `kanban_cards.board_id` con `ON DELETE CASCADE`: borrar un tablero borra
 *     sus tarjetas atómicamente en DB.
 *
 * Todo idempotente (`IF NOT EXISTS`) y reversible en `down()`.
 */
export class CreateKanbanTables1747012180000 implements MigrationInterface {
  name = 'CreateKanbanTables1747012180000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_boards" (
        "id" bigserial PRIMARY KEY,
        "company_id" bigint NOT NULL,
        "title" text NOT NULL,
        "position" double precision NOT NULL,
        "client_operation_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_kanban_boards_title_not_empty" CHECK (length(btrim("title")) > 0),
        CONSTRAINT "fk_kanban_boards_company" FOREIGN KEY ("company_id")
          REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_kanban_boards_company_id" ON "kanban_boards" ("company_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_kanban_boards_company_pos" ON "kanban_boards" ("company_id", "position")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_kanban_boards_client_operation"
         ON "kanban_boards" ("company_id", "client_operation_id")
         WHERE "client_operation_id" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_cards" (
        "id" bigserial PRIMARY KEY,
        "company_id" bigint NOT NULL,
        "board_id" bigint NOT NULL,
        "title" text NOT NULL,
        "description" text,
        "position" double precision NOT NULL,
        "client_operation_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_kanban_cards_title_not_empty" CHECK (length(btrim("title")) > 0),
        CONSTRAINT "fk_kanban_cards_company" FOREIGN KEY ("company_id")
          REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "fk_kanban_cards_board" FOREIGN KEY ("board_id")
          REFERENCES "kanban_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_kanban_cards_company_id" ON "kanban_cards" ("company_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_kanban_cards_board_id" ON "kanban_cards" ("board_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_kanban_cards_company_board_pos" ON "kanban_cards" ("company_id", "board_id", "position")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_kanban_cards_client_operation"
         ON "kanban_cards" ("company_id", "client_operation_id")
         WHERE "client_operation_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Primero las tarjetas (dependen del tablero), luego los tableros.
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_cards"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_boards"`);
  }
}
