import type { DataSource } from 'typeorm';

import { ExpandFactoryRolesPermissions1747011960000 } from '@/database/migrations/1747011960000-expand-factory-roles-permissions';

import { tryInitDataSource, createDisposableCompany, cleanupCompany } from './helpers/e2e-db';

/**
 * e2e de la MIGRACIÓN DE DATOS `ExpandFactoryRolesPermissions` contra pos_db.
 *
 * Ejercita la migración REAL (`.up(queryRunner)`) sobre estado simulado
 * pre-expansión (catálogo de 18 keys, Cajero de 5) en companies desechables:
 *   1. 'Administrador' (inmutable) → se FUERZA al set completo de 22 keys.
 *   2. 'Cajero' con el set viejo EXACTO de 5 → se actualiza al nuevo set de 12.
 *   3. 'Cajero' PERSONALIZADO (set distinto) → se RESPETA (no se toca).
 *   4. 'Vendedor' → se inserta en cada company que no lo tenga.
 *
 * La migración corre SQL global e idempotente; cada caso valida el efecto SOLO
 * en su company desechable.
 *
 * Patrón anti-CI-rojo: si pos_db no está disponible, `tryInitDataSource`
 * devuelve null y los casos se omiten en limpio.
 */
const OLD_ADMIN_18 = [
  'canAccessDashboard',
  'canAccessPOS',
  'canAccessInventory',
  'canAccessPackaging',
  'canAccessCategories',
  'canAccessBanks',
  'canAccessWallets',
  'canAccessCustomers',
  'canAccessEmployees',
  'canAccessCarriers',
  'canAccessSuppliers',
  'canAccessPurchase',
  'canAccessSalesReport',
  'canAccessDailyClosureReport',
  'canAccessCashierReport',
  'canAccessClientsReport',
  'canAccessExpenses',
  'canAccessSettings',
];

const OLD_CASHIER_5 = [
  'canAccessPOS',
  'canAccessSalesReport',
  'canAccessClientsReport',
  'canAccessExpenses',
  'canAccessCustomers',
];

describe('Migración de datos ExpandFactoryRolesPermissions (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  const createdCompanies: number[] = [];

  beforeAll(async () => {
    ds = await tryInitDataSource();
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    for (const id of createdCompanies) {
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

  const insertSystemRole = async (
    companyId: number,
    name: string,
    permissions: string[],
    isEditable = true,
  ): Promise<void> => {
    await ds!.query(
      `INSERT INTO roles (company_id, name, color, icon, permissions, is_system, is_editable)
       VALUES ($1, $2, '#000000', 'Icon', $3::jsonb, true, $4)`,
      [String(companyId), name, JSON.stringify(permissions), isEditable],
    );
  };

  const runMigration = async (): Promise<void> => {
    const runner = ds!.createQueryRunner();
    await runner.connect();
    try {
      await new ExpandFactoryRolesPermissions1747011960000().up(runner);
    } finally {
      await runner.release();
    }
  };

  const permsOf = async (companyId: number, name: string): Promise<string[]> => {
    const rows: Array<{ permissions: string[] }> = await ds!.query(
      `SELECT permissions FROM roles WHERE company_id = $1 AND lower(btrim(name)) = lower($2)`,
      [String(companyId), name],
    );
    return rows[0]?.permissions ?? [];
  };

  maybe('Admin viejo (18) → 22; Cajero viejo (5) → 12; Vendedor creado', async () => {
    const companyId = await createDisposableCompany(ds!, '__E2E_EXPAND_ROLES_A__');
    createdCompanies.push(companyId);

    await insertSystemRole(companyId, 'Administrador', OLD_ADMIN_18, false);
    await insertSystemRole(companyId, 'Cajero', OLD_CASHIER_5, true);

    await runMigration();

    // 1. Administrador → 22 keys, incluidas las nuevas.
    const admin = await permsOf(companyId, 'administrador');
    expect(admin).toHaveLength(22);
    expect(admin).toEqual(expect.arrayContaining(['canViewAllSales', 'canAccessFixedExpenses']));

    // 2. Cajero (set viejo exacto) → nuevo set de 12, con canViewAllSales.
    const cajero = await permsOf(companyId, 'cajero');
    expect(cajero).toHaveLength(12);
    expect(cajero).toEqual(
      expect.arrayContaining(['canViewAllSales', 'canAccessInventory', 'canAccessPurchase']),
    );
    expect(cajero).not.toContain('canAccessCashierReport');

    // 3. Vendedor → creado con sus 2 keys.
    const vendedor = await permsOf(companyId, 'vendedor');
    expect(vendedor).toEqual(['canAccessPOS', 'canAccessSalesReport']);
  });

  maybe('Cajero PERSONALIZADO (set distinto) → respetado (no se toca)', async () => {
    const companyId = await createDisposableCompany(ds!, '__E2E_EXPAND_ROLES_B__');
    createdCompanies.push(companyId);

    // Un owner que personalizó su Cajero: set que NO coincide con el viejo de 5.
    const custom = ['canAccessPOS', 'canAccessSalesReport'];
    await insertSystemRole(companyId, 'Cajero', custom, true);

    await runMigration();

    // Se respeta tal cual (la migración solo actualiza el Cajero de fábrica intacto).
    expect(await permsOf(companyId, 'cajero')).toEqual(custom);
  });
});
