import {
  isValidPermissionKey,
  LEGACY_EMPLOYEE_PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_SECTIONS,
  type PermissionKey,
} from '../internal/permission-catalog';

/**
 * Tests unitarios del catálogo canónico de permisos.
 *
 * Blindan la PARIDAD con placepos (mismas 22 keys, mismo orden, mismas
 * secciones/labels) y los invariantes de los que depende todo el sistema de
 * roles:
 *   - exactamente 22 keys, sin duplicados.
 *   - toda key aparece en EXACTAMENTE una sección (cobertura total, sin huérfanas).
 *   - las secciones no inventan keys fuera del catálogo.
 *   - `isValidPermissionKey` acepta sólo keys del catálogo.
 */
describe('permission-catalog', () => {
  // Snapshot literal de las 22 keys EXACTAS, en orden. Si alguien reordena o
  // renombra una key sin querer, este test lo caza (y recuerda replicar en
  // placepos).
  const EXPECTED_KEYS: PermissionKey[] = [
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
    'canAccessCreditsReport',
    'canAccessComparativeReport',
    'canAccessDailyClosureReport',
    'canAccessCashierReport',
    'canAccessClientsReport',
    'canViewAllSales',
    'canAccessExpenses',
    'canAccessFixedExpenses',
    'canAccessSettings',
  ];

  it('expone exactamente 22 keys en el orden canónico', () => {
    expect(PERMISSION_KEYS).toHaveLength(22);
    expect([...PERMISSION_KEYS]).toEqual(EXPECTED_KEYS);
  });

  it('no tiene keys duplicadas', () => {
    const unique = new Set<string>(PERMISSION_KEYS);
    expect(unique.size).toBe(PERMISSION_KEYS.length);
  });

  it('cada key del catálogo aparece en EXACTAMENTE una sección', () => {
    const keysInSections = PERMISSION_SECTIONS.flatMap((section) =>
      section.items.map((item) => item.key),
    );

    // Cobertura total: las 22 keys están repartidas.
    expect(keysInSections).toHaveLength(PERMISSION_KEYS.length);
    expect(new Set(keysInSections)).toEqual(new Set(PERMISSION_KEYS));

    // Sin repeticiones entre secciones.
    expect(new Set(keysInSections).size).toBe(keysInSections.length);

    // Toda key del catálogo está presente en alguna sección.
    for (const key of PERMISSION_KEYS) {
      expect(keysInSections).toContain(key);
    }
  });

  it('las secciones no contienen keys fuera del catálogo', () => {
    for (const section of PERMISSION_SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
      for (const item of section.items) {
        expect(isValidPermissionKey(item.key)).toBe(true);
        expect(item.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('mantiene los títulos de sección en el orden acordado', () => {
    const titles = PERMISSION_SECTIONS.map((section) => section.title);
    expect(titles).toEqual([
      'General',
      'Catálogos',
      'Tesorería',
      'Terceros',
      'Proveedores',
      'Informes',
      'Operación',
      'Sistema',
    ]);
  });

  // FASE 2 (ROLES) — fallback de empleado sin rol personalizado. El array es
  // contrato de PARIDAD con placepos: mismas keys, mismo orden.
  describe('LEGACY_EMPLOYEE_PERMISSIONS', () => {
    it('es exactamente el set legacy acordado, en orden', () => {
      expect(LEGACY_EMPLOYEE_PERMISSIONS).toEqual([
        'canAccessPOS',
        'canAccessInventory',
        'canAccessPackaging',
        'canAccessCategories',
        'canAccessCustomers',
        'canAccessCarriers',
        'canAccessSalesReport',
        'canAccessCreditsReport',
        'canAccessComparativeReport',
        'canAccessClientsReport',
        'canAccessExpenses',
        'canAccessFixedExpenses',
      ]);
    });

    it('todas sus keys son válidas y sin duplicados', () => {
      for (const key of LEGACY_EMPLOYEE_PERMISSIONS) {
        expect(isValidPermissionKey(key)).toBe(true);
      }
      expect(new Set(LEGACY_EMPLOYEE_PERMISSIONS).size).toBe(LEGACY_EMPLOYEE_PERMISSIONS.length);
    });
  });

  describe('isValidPermissionKey', () => {
    it('acepta todas las keys del catálogo', () => {
      for (const key of PERMISSION_KEYS) {
        expect(isValidPermissionKey(key)).toBe(true);
      }
    });

    it('rechaza keys desconocidas y valores no-string', () => {
      expect(isValidPermissionKey('canAccessLicenses')).toBe(false);
      expect(isValidPermissionKey('canAccessUnknown')).toBe(false);
      expect(isValidPermissionKey('')).toBe(false);
      expect(isValidPermissionKey(null)).toBe(false);
      expect(isValidPermissionKey(undefined)).toBe(false);
      expect(isValidPermissionKey(123)).toBe(false);
      expect(isValidPermissionKey({})).toBe(false);
    });
  });
});
