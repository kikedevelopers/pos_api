import type { DataSource } from 'typeorm';

import { FinalizeFactoryRoles1747011920000 } from '@/database/migrations/1747011920000-finalize-factory-roles';

import { tryInitDataSource, createDisposableCompany, cleanupCompany } from './helpers/e2e-db';

/**
 * FASE 5 — e2e de la MIGRACIÓN DE DATOS `FinalizeFactoryRoles` contra pos_db.
 *
 * Ejercita la migración REAL (`.up(queryRunner)`) sobre estado simulado
 * pre-FASE-5 en companies desechables:
 *   1. 'Administrador' (de sistema) pasa a INMUTABLE (`is_editable = false`) e
 *      'Inventarista' (de sistema, SIN empleados) queda BORRADO.
 *   2. 'Inventarista' (de sistema, CON un empleado asignado) se PRESERVA (guard
 *      `NOT EXISTS`), sin que la migración falle.
 *
 * La migración corre SQL global e idempotente: en un dev DB ya migrado, sus
 * statements son no-ops sobre el resto de companies. Cada caso valida el efecto
 * SOLO en su company desechable.
 *
 * Patrón anti-CI-rojo: si pos_db no está disponible, `tryInitDataSource`
 * devuelve null y los casos se omiten en limpio.
 */
describe('Migración de datos FinalizeFactoryRoles (e2e, pos_db) — FASE 5', () => {
  let ds: DataSource | null = null;
  const createdCompanies: number[] = [];

  beforeAll(async () => {
    ds = await tryInitDataSource();
  });

  afterAll(async () => {
    if (!ds) return;
    for (const id of createdCompanies) {
      // `cleanupCompany` no borra empleados; este suite inserta uno → limpiarlo
      // antes (la company tiene FK RESTRICT desde employees).
      await ds.query(`DELETE FROM employees WHERE company_id = $1`, [String(id)]);
      await cleanupCompany(ds, id);
    }
    await ds.destroy();
  });

  const maybe = (name: string, fn: () => Promise<void>): void =>
    void it(name, async () => {
      if (!ds) {
        console.warn('pos_db no disponible — test omitido');
        return;
      }
      await fn();
    });

  /** Inserta un rol de sistema en estado pre-migración (`is_editable = true`). */
  const insertSystemRole = async (companyId: number, name: string): Promise<string> => {
    const rows: Array<{ id: string }> = await ds!.query(
      `INSERT INTO roles (company_id, name, color, icon, permissions, is_system, is_editable)
       VALUES ($1, $2, '#000000', 'Icon', '[]'::jsonb, true, true)
       RETURNING id`,
      [String(companyId), name],
    );
    return rows[0].id;
  };

  const runMigration = async (): Promise<void> => {
    const runner = ds!.createQueryRunner();
    await runner.connect();
    try {
      await new FinalizeFactoryRoles1747011920000().up(runner);
    } finally {
      await runner.release();
    }
  };

  maybe('Administrador → inmutable; Inventarista sin empleados → borrado', async () => {
    const companyId = await createDisposableCompany(ds!, '__E2E_FACTORY_MIG_A__');
    createdCompanies.push(companyId);

    // Estado pre-FASE-5: 3 roles de sistema, Administrador aún editable.
    await insertSystemRole(companyId, 'Administrador');
    await insertSystemRole(companyId, 'Cajero');
    await insertSystemRole(companyId, 'Inventarista');

    await runMigration();

    const rows: Array<{ name: string; is_editable: boolean }> = await ds!.query(
      `SELECT name, is_editable FROM roles WHERE company_id = $1 ORDER BY name`,
      [String(companyId)],
    );

    // Inventarista borrado → quedan 2.
    expect(rows.map((r) => r.name)).toEqual(['Administrador', 'Cajero']);
    expect(rows.find((r) => r.name === 'Inventarista')).toBeUndefined();
    // Administrador quedó inmutable.
    expect(rows.find((r) => r.name === 'Administrador')?.is_editable).toBe(false);
    // Cajero permanece editable.
    expect(rows.find((r) => r.name === 'Cajero')?.is_editable).toBe(true);
  });

  maybe('Inventarista CON empleado asignado → preservado (no falla)', async () => {
    const companyId = await createDisposableCompany(ds!, '__E2E_FACTORY_MIG_B__');
    createdCompanies.push(companyId);

    await insertSystemRole(companyId, 'Administrador');
    const invId = await insertSystemRole(companyId, 'Inventarista');

    // Un empleado activo referencia el rol → el guard NOT EXISTS lo protege.
    await ds!.query(
      `INSERT INTO employees (company_id, name, role, role_id, is_archived)
       VALUES ($1, 'E2E Inventarista', 'employee', $2, false)`,
      [String(companyId), invId],
    );

    await runMigration();

    const rows: Array<{ name: string }> = await ds!.query(
      `SELECT name FROM roles WHERE company_id = $1 ORDER BY name`,
      [String(companyId)],
    );

    // Inventarista NO se borró (tiene empleado); Administrador inmutable igual.
    expect(rows.map((r) => r.name)).toContain('Inventarista');
  });
});
