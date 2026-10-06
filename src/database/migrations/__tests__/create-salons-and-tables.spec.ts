import type { QueryRunner } from 'typeorm';

import { CreateSalonsAndTables1747012700000 } from '../1747012700000-create-salons-and-tables';

/**
 * El módulo "Salones y Mesas" vive en estas dos tablas. Lo crítico de la
 * migración: multi-tenancy (company_id + FK + índice), el nombre único por
 * negocio liberable al archivar, el anclaje mesa→salón con ON DELETE SET NULL
 * (archivar un salón no debe borrar mesas) y el enum de estado re-ejecutable.
 */
describe('CreateSalonsAndTables1747012700000', () => {
  const buildRunner = (): { runner: QueryRunner; sql: () => string; calls: () => string[] } => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      sql: () => query.mock.calls.map((call) => String(call[0])).join('\n'),
      calls: () => query.mock.calls.map((call) => String(call[0])),
    };
  };

  const migration = new CreateSalonsAndTables1747012700000();

  describe('salons', () => {
    it('crea la tabla con company_id NOT NULL y FK CASCADE a companies (borra el tenant)', async () => {
      const { runner, sql } = buildRunner();
      await migration.up(runner);

      expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS "salons"/);
      expect(sql()).toMatch(/"company_id" bigint NOT NULL/);
      expect(sql()).toMatch(/fk_salons_company_id[\s\S]*REFERENCES "companies"[\s\S]*ON DELETE CASCADE/);
    });

    it('nombre único por negocio solo mientras no esté archivado', async () => {
      const { runner, sql } = buildRunner();
      await migration.up(runner);

      expect(sql()).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS "idx_salons_company_name_unique"[\s\S]*lower\(btrim\(name\)\)[\s\S]*WHERE is_archived = false/,
      );
    });

    it('exige nombre no vacío', async () => {
      const { runner, sql } = buildRunner();
      await migration.up(runner);

      expect(sql()).toMatch(/chk_salons_name_not_empty[\s\S]*length\(btrim\(name\)\) > 0/);
    });
  });

  describe('restaurant_tables', () => {
    it('crea el enum de estado de forma re-ejecutable', async () => {
      const { runner, sql } = buildRunner();
      await migration.up(runner);

      expect(sql()).toMatch(
        /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'restaurant_tables_status_enum'\)/,
      );
      expect(sql()).toMatch(/CREATE TYPE "restaurant_tables_status_enum" AS ENUM \('free', 'occupied'\)/);
    });

    it('crea el enum ANTES de la tabla que lo usa', async () => {
      const { runner, calls } = buildRunner();
      await migration.up(runner);

      const enum_index = calls().findIndex((s) => s.includes('CREATE TYPE "restaurant_tables_status_enum"'));
      const table_index = calls().findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS "restaurant_tables"'));
      expect(enum_index).toBeGreaterThanOrEqual(0);
      expect(table_index).toBeGreaterThan(enum_index);
    });

    it('tiene name, seats (>0) y status con default free', async () => {
      const { runner, sql } = buildRunner();
      await migration.up(runner);

      expect(sql()).toMatch(/"seats" integer NOT NULL DEFAULT 1/);
      expect(sql()).toMatch(/chk_restaurant_tables_seats_positive[\s\S]*seats > 0/);
      expect(sql()).toMatch(/"status" "restaurant_tables_status_enum" NOT NULL DEFAULT 'free'/);
    });

    it('ancla la mesa al salón con ON DELETE SET NULL (archivar no borra mesas)', async () => {
      const { runner, sql } = buildRunner();
      await migration.up(runner);

      expect(sql()).toMatch(
        /fk_restaurant_tables_salon_id[\s\S]*REFERENCES "salons"[\s\S]*ON DELETE SET NULL/,
      );
      expect(sql()).toMatch(/"salon_id" bigint NULL/);
      expect(sql()).toMatch(/"owned_by_salon" boolean NOT NULL DEFAULT false/);
    });

    it('nombre único por negocio liberable al archivar', async () => {
      const { runner, sql } = buildRunner();
      await migration.up(runner);

      expect(sql()).toMatch(
        /idx_restaurant_tables_company_name_unique[\s\S]*lower\(btrim\(name\)\)[\s\S]*WHERE is_archived = false/,
      );
    });
  });

  describe('estructura e idempotencia', () => {
    it('no hace backfill (sin UPDATE/INSERT)', async () => {
      const { runner, sql } = buildRunner();
      await migration.up(runner);

      // Un UPDATE real (con SET); "ON UPDATE CASCADE" de las FK no cuenta.
      expect(sql()).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
      expect(sql()).not.toMatch(/\bINSERT\s+INTO\b/i);
    });

    it('down elimina la mesa (y su enum) ANTES que el salón del que depende por FK', async () => {
      const { runner, calls } = buildRunner();
      await migration.down(runner);

      const tables_drop = calls().findIndex((s) => s.includes('DROP TABLE IF EXISTS "restaurant_tables"'));
      const enum_drop = calls().findIndex((s) => s.includes('DROP TYPE IF EXISTS "restaurant_tables_status_enum"'));
      const salons_drop = calls().findIndex((s) => s.includes('DROP TABLE IF EXISTS "salons"'));
      expect(tables_drop).toBeGreaterThanOrEqual(0);
      expect(enum_drop).toBeGreaterThan(tables_drop);
      expect(salons_drop).toBeGreaterThan(enum_drop);
    });
  });
});
