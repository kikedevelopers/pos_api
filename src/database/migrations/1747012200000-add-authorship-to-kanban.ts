import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Autoría en el Kanban: quién creó cada tablero/tarjeta (`created_by` snapshot
 * de nombre + `created_by_id` = users.id). Nullable (las filas previas no lo
 * tienen). El `created_at` ya existe desde `CreateKanbanTables`.
 */
export class AddAuthorshipToKanban1747012200000 implements MigrationInterface {
  name = 'AddAuthorshipToKanban1747012200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "kanban_boards" ADD COLUMN IF NOT EXISTS "created_by" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "kanban_boards" ADD COLUMN IF NOT EXISTS "created_by_id" bigint`,
    );
    await queryRunner.query(
      `ALTER TABLE "kanban_cards" ADD COLUMN IF NOT EXISTS "created_by" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "kanban_cards" ADD COLUMN IF NOT EXISTS "created_by_id" bigint`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "kanban_cards" DROP COLUMN IF EXISTS "created_by_id"`);
    await queryRunner.query(`ALTER TABLE "kanban_cards" DROP COLUMN IF EXISTS "created_by"`);
    await queryRunner.query(`ALTER TABLE "kanban_boards" DROP COLUMN IF EXISTS "created_by_id"`);
    await queryRunner.query(`ALTER TABLE "kanban_boards" DROP COLUMN IF EXISTS "created_by"`);
  }
}
