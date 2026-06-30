import type { DataSource } from 'typeorm';

import { PERMISSION_KEYS } from '@/modules/roles/internal/permission-catalog';
import { seedSystemRolesForCompany } from '@/modules/roles/internal/system-roles';

import { tryInitDataSource, createDisposableCompany, cleanupCompany } from './helpers/e2e-db';

/**
 * FASE 1 (ROLES Y PERMISOS) — e2e contra pos_db.
 *
 * Ejercita el helper REAL `seedSystemRolesForCompany` (el mismo que usa
 * `RegisterAction` y la migración de back-fill) contra Postgres de verdad:
 *   - verifica el cast `::jsonb`, los DEFAULTs y el CHECK de la tabla `roles`,
 *   - prueba la IDEMPOTENCIA real apoyada en el índice único funcional
 *     `idx_roles_company_name_unique` (correrlo dos veces no duplica),
 *   - confirma los 2 roles de fábrica con sus permisos y editabilidad exactos.
 *
 * Patrón anti-CI-rojo: si pos_db no está disponible, `tryInitDataSource`
 * devuelve null y los casos se omiten en limpio. Cada caso usa una company
 * desechable y borra TODO su rastro (incl. roles, que tienen FK RESTRICT a
 * companies) en su propia limpieza.
 *
 * Ahora son 3 roles de fábrica (Administrador, Cajero, Vendedor); 'Inventarista'
 * fue eliminado en FASE 5. Administrador nace INMUTABLE (`is_editable = false`).
 */
describe('Seed de roles de sistema por company (e2e, pos_db) — FASE 1/5', () => {
  let ds: DataSource | null = null;
  const createdCompanies: number[] = [];

  beforeAll(async () => {
    ds = await tryInitDataSource();
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    // `cleanupCompany` ya borra los roles (FK RESTRICT) antes de la company.
    for (const id of createdCompanies) {
      await cleanupCompany(ds, id);
    }
    await ds.destroy();
  });

  interface RoleRow {
    name: string;
    color: string;
    icon: string;
    permissions: string[];
    is_system: boolean;
    is_editable: boolean;
  }

  const rolesOf = async (companyId: number): Promise<RoleRow[]> => {
    return ds!.query(
      `SELECT name, color, icon, permissions, is_system, is_editable
             FROM roles WHERE company_id = $1 ORDER BY name`,
      [String(companyId)],
    );
  };

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!ds) {
        console.warn('pos_db no disponible — test omitido');
        return;
      }
      await fn();
    });

  maybe('siembra los 3 roles de fábrica con permisos y editabilidad exactos', async () => {
    const companyId = await createDisposableCompany(ds!, '__E2E_ROLES_SEED_A__');
    createdCompanies.push(companyId);

    await seedSystemRolesForCompany(ds!.manager, companyId);

    const roles = await rolesOf(companyId);
    expect(roles).toHaveLength(3);
    expect(roles.every((r) => r.is_system === true)).toBe(true);
    expect(roles.map((r) => r.name)).toEqual(['Administrador', 'Cajero', 'Vendedor']);
    // 'Inventarista' fue eliminado en FASE 5.
    expect(roles.find((r) => r.name === 'Inventarista')).toBeUndefined();

    const admin = roles.find((r) => r.name === 'Administrador')!;
    expect(admin.icon).toBe('ShieldCheck');
    expect(admin.color).toBe('#6366f1');
    // Administrador es INMUTABLE.
    expect(admin.is_editable).toBe(false);
    // jsonb se devuelve ya parseado como array por el driver pg.
    expect(admin.permissions).toEqual([...PERMISSION_KEYS]);

    const cajero = roles.find((r) => r.name === 'Cajero')!;
    // Cajero es EDITABLE.
    expect(cajero.is_editable).toBe(true);
    expect(cajero.permissions).toEqual([
      'canAccessPOS',
      'canAccessInventory',
      'canAccessPackaging',
      'canAccessCategories',
      'canAccessCustomers',
      'canAccessPurchase',
      'canAccessSalesReport',
      'canAccessCreditsReport',
      'canAccessDailyClosureReport',
      'canAccessClientsReport',
      'canAccessExpenses',
      'canViewAllSales',
    ]);

    const vendedor = roles.find((r) => r.name === 'Vendedor')!;
    // Vendedor es EDITABLE: solo POS + informe de Ventas.
    expect(vendedor.is_editable).toBe(true);
    expect(vendedor.permissions).toEqual(['canAccessPOS', 'canAccessSalesReport']);
  });

  maybe('es idempotente contra la BD real: dos corridas no duplican', async () => {
    const companyId = await createDisposableCompany(ds!, '__E2E_ROLES_SEED_B__');
    createdCompanies.push(companyId);

    await seedSystemRolesForCompany(ds!.manager, companyId);
    await seedSystemRolesForCompany(ds!.manager, companyId);

    const roles = await rolesOf(companyId);
    expect(roles).toHaveLength(3);
  });
});
