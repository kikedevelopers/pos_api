import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lista de tareas (checklist) de las tarjetas del Kanban: `kanban_checklist_items`.
 * Multi-tenant por `company_id`; `card_id` con `ON DELETE CASCADE` (borrar la
 * tarjeta borra sus ítems). `position double precision` (rank fraccionado).
 * Índice `(company_id, card_id, position)` para leer ordenado con un escaneo.
 */
export class CreateKanbanChecklist1747012220000 implements MigrationInterface {
  name = 'CreateKanbanChecklist1747012220000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kanban_checklist_items" (
        "id" bigserial PRIMARY KEY,
        "company_id" bigint NOT NULL,
        "card_id" bigint NOT NULL,
        "text" text NOT NULL,
        "is_done" boolean NOT NULL DEFAULT false,
        "position" double precision NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_kanban_checklist_text_not_empty" CHECK (length(btrim("text")) > 0),
        CONSTRAINT "fk_kanban_checklist_company" FOREIGN KEY ("company_id")
          REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "fk_kanban_checklist_card" FOREIGN KEY ("card_id")
          REFERENCES "kanban_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_kanban_checklist_company_id" ON "kanban_checklist_items" ("company_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_kanban_checklist_card_id" ON "kanban_checklist_items" ("card_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_kanban_checklist_company_card_pos" ON "kanban_checklist_items" ("company_id", "card_id", "position")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "kanban_checklist_items"`);
  }
}
