import type { EntityManager } from 'typeorm';

import { PERMISSION_KEYS } from '../internal/permission-catalog';
import { seedSystemRolesForCompany } from '../internal/system-roles';

/**
 * Tests unitarios de `seedSystemRolesForCompany`.
 *
 * Verifican:
 *   - Crea EXACTAMENTE los 3 roles de fábrica con sus permisos, ícono, color y
 *     `is_system = true` esperados.
 *   - El array de permisos de cada rol es EXACTO (catálogo completo para
 *     Administrador; subconjuntos literales para Cajero/Inventarista).
 *   - IDEMPOTENTE: correrlo dos veces NO duplica (sigue habiendo 3 roles).
 *   - Aislamiento multi-tenant: sembrar otra company no toca la primera.
 *
 * El `EntityManager` se mockea con un store en memoria que interpreta el SELECT
 * de nombres existentes y el INSERT de cada rol (los dos únicos tipos de query
 * que emite el helper).
 */
interface RoleRow {
  company_id: string;
  name: string;
  color: string;
  icon: string;
  permissions: string;
  is_system: boolean;
}

function createManagerMock(store: RoleRow[]): { manager: EntityManager; query: jest.Mock } {
  const query = jest.fn((sql: string, params: unknown[] = []): Promise<unknown> => {
    if (/^\s*SELECT/i.test(sql)) {
      const cid = String(params[0]);
      const rows = store
        .filter((r) => r.company_id === cid)
        .map((r) => ({ norm: r.name.trim().toLowerCase() }));
      return Promise.resolve(rows);
    }
    if (/^\s*INSERT/i.test(sql)) {
      const [cid, name, color, icon, permissions] = params as string[];
      store.push({
        company_id: String(cid),
        name,
        color,
        icon,
        permissions,
        is_system: true,
      });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });

  const manager = { query } as unknown as EntityManager;
  return { manager, query };
}

function rolesFor(store: RoleRow[], companyId: string): RoleRow[] {
  return store.filter((r) => r.company_id === companyId);
}

function permsOf(store: RoleRow[], companyId: string, name: string): string[] {
  const row = store.find((r) => r.company_id === companyId && r.name === name);
  if (!row) {
    throw new Error(`Rol no encontrado: ${name}`);
  }
  return JSON.parse(row.permissions) as string[];
}

describe('seedSystemRolesForCompany', () => {
  const COMPANY = '42';

  it('crea exactamente 3 roles de sistema con metadata y permisos exactos', async () => {
    const store: RoleRow[] = [];
    const { manager } = createManagerMock(store);

    await seedSystemRolesForCompany(manager, COMPANY);

    const roles = rolesFor(store, COMPANY);
    expect(roles).toHaveLength(3);
    expect(roles.every((r) => r.is_system === true)).toBe(true);
    expect(new Set(roles.map((r) => r.name))).toEqual(
      new Set(['Administrador', 'Cajero', 'Inventarista']),
    );

    // Administrador → metadata + TODAS las 18 keys del catálogo, en orden.
    const admin = roles.find((r) => r.name === 'Administrador');
    expect(admin?.icon).toBe('ShieldCheck');
    expect(admin?.color).toBe('#6366f1');
    expect(permsOf(store, COMPANY, 'Administrador')).toEqual([...PERMISSION_KEYS]);

    // Cajero → metadata + subconjunto literal exacto.
    const cajero = roles.find((r) => r.name === 'Cajero');
    expect(cajero?.icon).toBe('Receipt');
    expect(cajero?.color).toBe('#10b981');
    expect(permsOf(store, COMPANY, 'Cajero')).toEqual([
      'canAccessPOS',
      'canAccessSalesReport',
      'canAccessClientsReport',
      'canAccessExpenses',
      'canAccessCustomers',
    ]);

    // Inventarista → metadata + subconjunto literal exacto.
    const inv = roles.find((r) => r.name === 'Inventarista');
    expect(inv?.icon).toBe('Package');
    expect(inv?.color).toBe('#f59e0b');
    expect(permsOf(store, COMPANY, 'Inventarista')).toEqual([
      'canAccessInventory',
      'canAccessPackaging',
      'canAccessCategories',
      'canAccessSuppliers',
      'canAccessPurchase',
    ]);
  });

  it('es idempotente: correrlo dos veces no duplica roles', async () => {
    const store: RoleRow[] = [];
    const { manager, query } = createManagerMock(store);

    await seedSystemRolesForCompany(manager, COMPANY);
    const insertsAfterFirst = query.mock.calls.filter(([sql]) =>
      /^\s*INSERT/i.test(sql as string),
    ).length;
    expect(insertsAfterFirst).toBe(3);

    await seedSystemRolesForCompany(manager, COMPANY);

    // Sigue habiendo 3 roles: la segunda corrida no insertó nada nuevo.
    expect(rolesFor(store, COMPANY)).toHaveLength(3);
    const totalInserts = query.mock.calls.filter(([sql]) =>
      /^\s*INSERT/i.test(sql as string),
    ).length;
    expect(totalInserts).toBe(3);
  });

  it('respeta nombres preexistentes case/trim-insensitive (no duplica)', async () => {
    // Una company que ya tiene un rol "administrador" en minúsculas con espacios.
    const store: RoleRow[] = [
      {
        company_id: COMPANY,
        name: '  administrador ',
        color: '#000000',
        icon: 'Custom',
        permissions: '[]',
        is_system: false,
      },
    ];
    const { manager } = createManagerMock(store);

    await seedSystemRolesForCompany(manager, COMPANY);

    // Administrador NO se re-inserta (ya existe normalizado); sólo se agregan
    // Cajero e Inventarista → 1 preexistente + 2 nuevos = 3.
    const roles = rolesFor(store, COMPANY);
    expect(roles).toHaveLength(3);
    expect(roles.filter((r) => r.name.trim().toLowerCase() === 'administrador')).toHaveLength(1);
  });

  it('aísla por tenant: sembrar otra company no toca la primera', async () => {
    const store: RoleRow[] = [];
    const { manager } = createManagerMock(store);

    await seedSystemRolesForCompany(manager, COMPANY);
    await seedSystemRolesForCompany(manager, '99');

    expect(rolesFor(store, COMPANY)).toHaveLength(3);
    expect(rolesFor(store, '99')).toHaveLength(3);
    expect(store).toHaveLength(6);
  });
});
