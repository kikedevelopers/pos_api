import type { EntityManager } from 'typeorm';

import { resolvePackagingValues } from '../resolve-packaging-value.helper';

/**
 * FIX #2 — Unit tests de `resolvePackagingValues` con un `EntityManager` mock
 * (sin BD). Blindan los tres contratos clave del snapshot de packaging:
 *
 *   1. ESTRICTO (default): resuelve solo productos de la propia company vía
 *      `manager.find(Product, { where: { company_id } })`.
 *   2. CROSS-COMPANY: resuelve el set accesible vía `resolveAccessibleProducts`
 *      (que internamente hace `manager.query(...)`) y carga los packagings de
 *      productos compartidos SIN filtro de company.
 *   3. TOLERANTE: un packaging inválido (<= 0 / no finito) o ausente NO lanza —
 *      el producto se OMITE del Map (→ el caller persiste null y el motor cae a
 *      su fallback). Sin packaging → factor 1.
 */
describe('resolvePackagingValues (FIX #2 snapshot)', () => {
  interface SeedProduct {
    id: number;
    company_id: number;
    packaging_id: number | null;
    parent_id?: number | null;
    name?: string;
  }
  interface SeedPackaging {
    id: number;
    company_id: number;
    value: number;
  }

  /** FindOperator `In([...])` expone su payload en `_value`. */
  const extractIds = (where: Record<string, unknown>): string[] =>
    (where.id as { _value?: string[] })?._value ?? [];

  /**
   * Mock de EntityManager. `find(Product)` aplica filtro estricto por company
   * (modo no-cross). `find(Packaging)` respeta o no el filtro de company según
   * venga en el `where`. `query(...)` simula `resolveAccessibleProducts`
   * devolviendo las filas accesibles configuradas (modo cross).
   */
  function buildManager(opts: {
    products: SeedProduct[];
    packagings: SeedPackaging[];
    /** Filas que `resolveAccessibleProducts` (manager.query) devuelve en cross. */
    accessible?: SeedProduct[];
  }): EntityManager {
    const managerMock = {
      find: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown[]> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const ids = extractIds(options.where);
          if (entityName === 'Product') {
            const companyId = options.where.company_id as string | undefined;
            return Promise.resolve(
              opts.products
                .filter(
                  (p) =>
                    ids.includes(String(p.id)) &&
                    (companyId === undefined || String(p.company_id) === companyId),
                )
                .map((p) => ({
                  id: String(p.id),
                  packaging_id: p.packaging_id !== null ? String(p.packaging_id) : null,
                })),
            );
          }
          if (entityName === 'Packaging') {
            const companyId = options.where.company_id as string | undefined;
            return Promise.resolve(
              opts.packagings
                .filter(
                  (pk) =>
                    ids.includes(String(pk.id)) &&
                    (companyId === undefined || String(pk.company_id) === companyId),
                )
                .map((pk) => ({ id: String(pk.id), value: pk.value })),
            );
          }
          return Promise.resolve([]);
        },
      ),
      // resolveAccessibleProducts usa manager.query(sql, [ids, ...]).
      query: jest.fn((_sql: string, params: unknown[]): Promise<unknown[]> => {
        const ids = (params[0] as string[]).map(String);
        return Promise.resolve(
          (opts.accessible ?? [])
            .filter((p) => ids.includes(String(p.id)))
            .map((p) => ({
              id: String(p.id),
              company_id: String(p.company_id),
              parent_id: p.parent_id != null ? String(p.parent_id) : null,
              packaging_id: p.packaging_id !== null ? String(p.packaging_id) : null,
              name: p.name ?? `P${p.id}`,
            })),
        );
      }),
    };
    return managerMock as unknown as EntityManager;
  }

  it('itemIds vacío → Map vacío (sin tocar la BD)', async () => {
    const manager = buildManager({ products: [], packagings: [] });
    const map = await resolvePackagingValues(manager, 1, []);
    expect(map.size).toBe(0);
  });

  it('ESTRICTO: producto sin packaging → factor 1', async () => {
    const manager = buildManager({
      products: [{ id: 10, company_id: 1, packaging_id: null }],
      packagings: [],
    });
    const map = await resolvePackagingValues(manager, 1, [10]);
    expect(map.get(10)).toBe(1);
  });

  it('ESTRICTO: producto con packaging → su value', async () => {
    const manager = buildManager({
      products: [{ id: 10, company_id: 1, packaging_id: 5 }],
      packagings: [{ id: 5, company_id: 1, value: 12 }],
    });
    const map = await resolvePackagingValues(manager, 1, [10]);
    expect(map.get(10)).toBe(12);
  });

  it('ESTRICTO: producto de OTRA company → omitido (no aparece en el Map)', async () => {
    const manager = buildManager({
      products: [{ id: 10, company_id: 999, packaging_id: 5 }],
      packagings: [{ id: 5, company_id: 999, value: 12 }],
    });
    const map = await resolvePackagingValues(manager, 1, [10]);
    expect(map.has(10)).toBe(false);
  });

  it('TOLERANTE: packaging con value 0 (inválido) → OMITIDO, NO lanza', async () => {
    const manager = buildManager({
      products: [{ id: 10, company_id: 1, packaging_id: 5 }],
      packagings: [{ id: 5, company_id: 1, value: 0 }],
    });
    let map: Map<number, number> | undefined;
    await expect(
      (async () => {
        map = await resolvePackagingValues(manager, 1, [10]);
      })(),
    ).resolves.not.toThrow();
    expect(map?.has(10)).toBe(false);
  });

  it('TOLERANTE: packaging ausente (id no existe) → OMITIDO, NO lanza', async () => {
    const manager = buildManager({
      products: [{ id: 10, company_id: 1, packaging_id: 5 }],
      packagings: [], // el packaging 5 no existe
    });
    const map = await resolvePackagingValues(manager, 1, [10]);
    expect(map.has(10)).toBe(false);
  });

  it('MIXTO: válido→value, sin packaging→1, inválido→omitido (todo en una pasada)', async () => {
    const manager = buildManager({
      products: [
        { id: 10, company_id: 1, packaging_id: 5 }, // válido
        { id: 11, company_id: 1, packaging_id: null }, // simple
        { id: 12, company_id: 1, packaging_id: 6 }, // inválido
      ],
      packagings: [
        { id: 5, company_id: 1, value: 24 },
        { id: 6, company_id: 1, value: -3 },
      ],
    });
    const map = await resolvePackagingValues(manager, 1, [10, 11, 12]);
    expect(map.get(10)).toBe(24);
    expect(map.get(11)).toBe(1);
    expect(map.has(12)).toBe(false);
  });

  it('CROSS-COMPANY: producto COMPARTIDO por el principal → congela el value del principal', async () => {
    // Company activa = 2 (sucursal). El producto 10 pertenece al principal (1)
    // y su packaging (5) vive también en el principal. En cross, el helper lo
    // resuelve vía resolveAccessibleProducts y carga el packaging SIN filtro de
    // company → obtiene W=10 del principal.
    const manager = buildManager({
      products: [], // en cross NO se usa find(Product)
      packagings: [{ id: 5, company_id: 1, value: 10 }],
      accessible: [{ id: 10, company_id: 1, packaging_id: 5 }],
    });
    const map = await resolvePackagingValues(manager, 2, [10], true);
    expect(map.get(10)).toBe(10);
  });

  it('CROSS-COMPANY: compartido con packaging inválido → OMITIDO (tolerante también en cross)', async () => {
    const manager = buildManager({
      products: [],
      packagings: [{ id: 5, company_id: 1, value: 0 }],
      accessible: [{ id: 10, company_id: 1, packaging_id: 5 }],
    });
    const map = await resolvePackagingValues(manager, 2, [10], true);
    expect(map.has(10)).toBe(false);
  });

  it('CROSS-COMPANY: compartido sin packaging → factor 1', async () => {
    const manager = buildManager({
      products: [],
      packagings: [],
      accessible: [{ id: 10, company_id: 1, packaging_id: null }],
    });
    const map = await resolvePackagingValues(manager, 2, [10], true);
    expect(map.get(10)).toBe(1);
  });
});
