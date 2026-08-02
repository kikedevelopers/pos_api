import type { EntityManager } from 'typeorm';

import { adjustInventory, InsufficientStockError } from '../adjust-inventory.helper';

/**
 * Producto COMBO en el motor de inventario — espejo del suite de placepos.
 *
 * Un combo no tiene stock propio: al venderlo, el motor lo reemplaza por las
 * líneas de sus componentes y descuenta de CADA base la cantidad de la receta
 * (expresada en la unidad mínima del base).
 *
 * Escenario del negocio (company 42):
 *   MANÍ CON SAL X KILO  (id 1) — empaque KILO (x1000) — stock 5.000 g
 *   UVA PASA X KILO      (id 2) — empaque KILO (x1000) — stock 3.000 g
 *   COMBO MIX            (id 9) — sin empaque, receta: 25 g maní + 30 g uva
 */
describe('adjustInventory — producto COMBO (receta de N bases)', () => {
  const COMPANY_ID = 42;

  interface SeedProduct {
    id: number;
    name: string;
    stock: number;
    packaging_id: number | null;
    parent_id?: number | null;
    product_type?: 'SIMPLE' | 'COMBO';
  }

  interface SeedRecipeRow {
    combo_product_id: number;
    component_product_id: number;
    quantity: number;
  }

  interface ManagerHarness {
    manager: EntityManager;
    stockOf: (id: number) => number;
    movements: Array<Record<string, unknown>>;
  }

  function buildManager(opts: {
    products: SeedProduct[];
    packagings: Array<{ id: number; value: number }>;
    recipe?: SeedRecipeRow[];
    strict?: boolean;
  }): ManagerHarness {
    const movements: Array<Record<string, unknown>> = [];
    // El stock vive en este mapa: los UPDATE lo mutan, igual que en Postgres
    // dentro de la transacción.
    const stocks = new Map(opts.products.map((p) => [p.id, p.stock]));
    const productById = new Map(opts.products.map((p) => [String(p.id), p]));
    const recipe = opts.recipe ?? [];

    const extractIds = (where: Record<string, unknown>): string[] =>
      (where?.id as { _value?: string[] })?._value ?? [];

    // El where de la receta llega como array de {company_id, combo_product_id}.
    const extractComboIds = (where: unknown): number[] => {
      if (!Array.isArray(where)) {
        return [];
      }
      return where.map((w: { combo_product_id: string }) => Number(w.combo_product_id));
    };

    const managerMock = {
      find: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown[]> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          if (entityName === 'ComboComponent') {
            const comboIds = extractComboIds(options.where);
            return Promise.resolve(
              recipe
                .filter((r) => comboIds.includes(r.combo_product_id))
                .map((r) => ({
                  combo_product_id: String(r.combo_product_id),
                  component_product_id: String(r.component_product_id),
                  quantity: r.quantity,
                })),
            );
          }
          const ids = extractIds(options.where);
          if (entityName === 'Product') {
            return Promise.resolve(
              ids
                .map((id) => productById.get(String(id)))
                .filter((p): p is SeedProduct => p !== undefined)
                .map((p) => ({
                  id: String(p.id),
                  parent_id:
                    p.parent_id !== null && p.parent_id !== undefined ? String(p.parent_id) : null,
                  packaging_id: p.packaging_id !== null ? String(p.packaging_id) : null,
                  name: p.name,
                  product_type: p.product_type ?? 'SIMPLE',
                })),
            );
          }
          if (entityName === 'Packaging') {
            return Promise.resolve(
              opts.packagings
                .filter((pk) => ids.includes(String(pk.id)))
                .map((pk) => ({ id: String(pk.id), value: pk.value })),
            );
          }
          return Promise.resolve([]);
        },
      ),
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => ({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          getMany: jest.fn(() =>
            Promise.resolve(
              opts.products.map((p) => ({
                id: String(p.id),
                name: p.name,
                stock: stocks.get(p.id) ?? 0,
                company_id: String(COMPANY_ID),
              })),
            ),
          ),
        })),
      })),
      findOne: jest.fn((entity: { name?: string } | string): Promise<unknown> => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (entityName === 'AppSetting') {
          return Promise.resolve({ value: opts.strict ? 'true' : 'false' });
        }
        return Promise.resolve(null);
      }),
      update: jest.fn(
        (entity: { name?: string } | string, where: { id: string }, patch: { stock: number }) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          if (entityName === 'Product') {
            stocks.set(Number(where.id), patch.stock);
          }
          return Promise.resolve({ affected: 1 });
        },
      ),
      insert: jest.fn((entity: { name?: string } | string, row: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (entityName === 'InventoryMovement') {
          movements.push(row);
        }
        return Promise.resolve({ identifiers: [] });
      }),
    };

    return {
      manager: managerMock as unknown as EntityManager,
      stockOf: (id: number) => stocks.get(id) ?? 0,
      movements,
    };
  }

  const seedMix = (overrides: { uvaStock?: number; strict?: boolean } = {}): ManagerHarness =>
    buildManager({
      strict: overrides.strict,
      products: [
        {
          id: 1,
          name: 'MANÍ CON SAL X KILO',
          stock: 5000,
          packaging_id: 300,
          product_type: 'SIMPLE',
        },
        {
          id: 2,
          name: 'UVA PASA X KILO',
          stock: overrides.uvaStock ?? 3000,
          packaging_id: 300,
          product_type: 'SIMPLE',
        },
        { id: 9, name: 'COMBO MIX', stock: 0, packaging_id: null, product_type: 'COMBO' },
      ],
      packagings: [{ id: 300, value: 1000 }],
      recipe: [
        { combo_product_id: 9, component_product_id: 1, quantity: 25 },
        { combo_product_id: 9, component_product_id: 2, quantity: 30 },
      ],
    });

  it('DEDUCT de 1 combo descuenta 25 g de maní y 30 g de uva pasa', async () => {
    const h = seedMix();
    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 1 }], 'DEDUCT');

    expect(h.stockOf(1)).toBe(4975);
    expect(h.stockOf(2)).toBe(2970);
  });

  it('el COMBO no muta su propio stock ni genera movimiento propio', async () => {
    const h = seedMix();
    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 1 }], 'DEDUCT');

    expect(h.stockOf(9)).toBe(0);
    expect(h.movements.some((m) => Number(m.product_id) === 9)).toBe(false);
    expect(h.movements).toHaveLength(2);
  });

  it('la cantidad del combo multiplica la receta (4 combos = 100 g + 120 g)', async () => {
    const h = seedMix();
    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 4 }], 'DEDUCT');

    expect(h.stockOf(1)).toBe(4900);
    expect(h.stockOf(2)).toBe(2880);
  });

  it('el empaque del componente NO se vuelve a aplicar: la receta ya está en unidad mínima', async () => {
    // El maní tiene empaque x1000. Si el motor multiplicara por él, 25 g se
    // convertirían en 25.000 g y el stock quedaría en −20.000.
    const h = seedMix();
    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 1 }], 'DEDUCT');
    expect(h.stockOf(1)).toBe(4975);
  });

  it('RETURN devuelve exactamente lo descontado (simetría venta ↔ anulación)', async () => {
    const h = seedMix();
    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 3 }], 'DEDUCT');
    expect(h.stockOf(1)).toBe(4925);
    expect(h.stockOf(2)).toBe(2910);

    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 3 }], 'RETURN');
    expect(h.stockOf(1)).toBe(5000);
    expect(h.stockOf(2)).toBe(3000);
  });

  it('combo + producto suelto del MISMO base se agregan en un solo movimiento', async () => {
    const h = seedMix();
    await adjustInventory(
      h.manager,
      COMPANY_ID,
      [
        { item_id: 9, quantity: 1 },
        { item_id: 1, quantity: 1, packaging_value: 1000 },
      ],
      'DEDUCT',
    );

    expect(h.stockOf(1)).toBe(3975);
    const maniMovements = h.movements.filter((m) => Number(m.product_id) === 1);
    expect(maniMovements).toHaveLength(1);
    expect(maniMovements[0]?.quantity).toBe(1025);
  });

  it('strict ON: si un componente no alcanza, LANZA InsufficientStockError', async () => {
    const h = seedMix({ uvaStock: 10, strict: true });
    await expect(
      adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 1 }], 'DEDUCT'),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(h.stockOf(2)).toBe(10);
  });

  it('strict ON + overrideStock: permite dejar el componente en negativo', async () => {
    const h = seedMix({ uvaStock: 10, strict: true });
    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 1 }], 'DEDUCT', {
      overrideStock: true,
    });
    expect(h.stockOf(2)).toBe(-20);
  });

  it('combo SIN receta no descuenta nada (no aborta la venta)', async () => {
    const h = buildManager({
      products: [
        { id: 9, name: 'COMBO VACÍO', stock: 0, packaging_id: null, product_type: 'COMBO' },
      ],
      packagings: [],
      recipe: [],
    });
    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 5 }], 'DEDUCT');
    expect(h.movements).toHaveLength(0);
  });

  it('receta con cantidad decimal se aplica con precisión Big (0,5 × 3)', async () => {
    const h = buildManager({
      products: [
        { id: 1, name: 'ESENCIA', stock: 100, packaging_id: null, product_type: 'SIMPLE' },
        { id: 9, name: 'COMBO ESENCIA', stock: 0, packaging_id: null, product_type: 'COMBO' },
      ],
      packagings: [],
      recipe: [{ combo_product_id: 9, component_product_id: 1, quantity: 0.5 }],
    });
    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 9, quantity: 3 }], 'DEDUCT');
    expect(h.stockOf(1)).toBe(98.5);
  });

  it('un catálogo SIN combos se comporta exactamente igual que antes', async () => {
    const h = buildManager({
      products: [{ id: 10, name: 'Arroz granel', stock: 50000, packaging_id: 5 }],
      packagings: [{ id: 5, value: 1000 }],
    });
    await adjustInventory(h.manager, COMPANY_ID, [{ item_id: 10, quantity: 2 }], 'DEDUCT');
    expect(h.stockOf(10)).toBe(48000);
    expect(h.movements[0]?.quantity).toBe(2000);
  });

  /**
   * FIX #3 — Receta CONGELADA en la línea.
   *
   * Sin snapshot, el RETURN vuelve a leer `combo_components` y usa la receta
   * VIGENTE: editarla entre la venta y su anulación deja stock perdido o
   * fantasma, en silencio. Con snapshot, el RETURN deshace EXACTAMENTE el
   * DEDUCT. Es la misma garantía que FIX #2 dio al factor de empaque.
   *
   * `seedMix` monta la receta vigente 25 g maní + 30 g uva pasa; los tests de
   * abajo pasan un snapshot DISTINTO para probar cuál manda.
   */
  describe('receta congelada (combo_recipe)', () => {
    const FROZEN = [
      { component_product_id: 1, quantity: 25 },
      { component_product_id: 2, quantity: 30 },
    ];

    it('el snapshot manda sobre la receta vigente', async () => {
      const h = seedMix();
      await adjustInventory(
        h.manager,
        COMPANY_ID,
        // La receta en BD dice 25/30; la congelada dice 10/5.
        [
          {
            item_id: 9,
            quantity: 1,
            combo_recipe: [
              { component_product_id: 1, quantity: 10 },
              { component_product_id: 2, quantity: 5 },
            ],
          },
        ],
        'DEDUCT',
      );
      expect(h.stockOf(1)).toBe(4990);
      expect(h.stockOf(2)).toBe(2995);
    });

    it('no consulta combo_components si la línea ya trae su receta', async () => {
      const h = seedMix();
      await adjustInventory(
        h.manager,
        COMPANY_ID,
        [{ item_id: 9, quantity: 1, combo_recipe: FROZEN }],
        'DEDUCT',
      );
      const findMock = h.manager.find as unknown as jest.Mock;
      expect(
        findMock.mock.calls.some(
          ([entity]) => (entity as { name?: string })?.name === 'ComboComponent',
        ),
      ).toBe(false);
    });

    it('sin snapshot (legacy) sigue leyendo la receta vigente', async () => {
      const h = seedMix();
      await adjustInventory(
        h.manager,
        COMPANY_ID,
        [{ item_id: 9, quantity: 1, combo_recipe: null }],
        'DEDUCT',
      );
      expect(h.stockOf(1)).toBe(4975);
      expect(h.stockOf(2)).toBe(2970);
    });

    it('un snapshot VACÍO no devuelve nada (no reexpande contra la receta de hoy)', async () => {
      const h = seedMix();
      await adjustInventory(
        h.manager,
        COMPANY_ID,
        [{ item_id: 9, quantity: 1, combo_recipe: [] }],
        'RETURN',
      );
      expect(h.stockOf(1)).toBe(5000);
      expect(h.stockOf(2)).toBe(3000);
    });

    /**
     * Los tres modos de romper la simetría, uno por test. En los tres, el
     * stock final DEBE volver al inicial (5.000 g y 3.000 g).
     */
    describe('simetría DEDUCT ↔ RETURN con la receta editada entre medias', () => {
      it('QUITAR un componente: su stock igual vuelve', async () => {
        const h = seedMix();
        await adjustInventory(
          h.manager,
          COMPANY_ID,
          [{ item_id: 9, quantity: 10, combo_recipe: FROZEN }],
          'DEDUCT',
        );
        expect(h.stockOf(1)).toBe(4750);
        expect(h.stockOf(2)).toBe(2700);

        // El usuario quita la uva pasa de la receta...
        await adjustInventory(
          h.manager,
          COMPANY_ID,
          [{ item_id: 9, quantity: 10, combo_recipe: FROZEN }],
          'RETURN',
        );
        // ...y aun así los 300 g vuelven, porque la línea recuerda la receta.
        expect(h.stockOf(1)).toBe(5000);
        expect(h.stockOf(2)).toBe(3000);
      });

      it('SUBIR una cantidad: no aparece stock fantasma', async () => {
        const h = seedMix();
        await adjustInventory(
          h.manager,
          COMPANY_ID,
          [{ item_id: 9, quantity: 10, combo_recipe: FROZEN }],
          'DEDUCT',
        );
        // La receta pasa a 50 g de maní; el RETURN usa el snapshot (25 g).
        await adjustInventory(
          h.manager,
          COMPANY_ID,
          [{ item_id: 9, quantity: 10, combo_recipe: FROZEN }],
          'RETURN',
        );
        expect(h.stockOf(1)).toBe(5000);
      });

      it('AÑADIR un componente: no se repone lo que nunca se descontó', async () => {
        const h = buildManager({
          products: [
            { id: 1, name: 'MANÍ', stock: 5000, packaging_id: null, product_type: 'SIMPLE' },
            { id: 3, name: 'AZÚCAR', stock: 800, packaging_id: null, product_type: 'SIMPLE' },
            { id: 9, name: 'COMBO MIX', stock: 0, packaging_id: null, product_type: 'COMBO' },
          ],
          packagings: [],
          // Receta VIGENTE: alguien añadió el azúcar después de la venta.
          recipe: [
            { combo_product_id: 9, component_product_id: 1, quantity: 25 },
            { combo_product_id: 9, component_product_id: 3, quantity: 5 },
          ],
        });
        await adjustInventory(
          h.manager,
          COMPANY_ID,
          [{ item_id: 9, quantity: 4, combo_recipe: [{ component_product_id: 1, quantity: 25 }] }],
          'RETURN',
        );
        expect(h.stockOf(1)).toBe(5100);
        expect(h.stockOf(3)).toBe(800);
      });
    });

    it('el snapshot multiplica igual por la cantidad vendida', async () => {
      const h = seedMix();
      await adjustInventory(
        h.manager,
        COMPANY_ID,
        [{ item_id: 9, quantity: 4, combo_recipe: FROZEN }],
        'DEDUCT',
      );
      expect(h.stockOf(1)).toBe(4900);
      expect(h.stockOf(2)).toBe(2880);
    });

    it('convive con líneas sueltas y con combos legacy en la misma operación', async () => {
      const h = seedMix();
      await adjustInventory(
        h.manager,
        COMPANY_ID,
        [
          // Combo con snapshot: 10 g de maní.
          { item_id: 9, quantity: 1, combo_recipe: [{ component_product_id: 1, quantity: 10 }] },
          // Producto suelto: 1 KILO de maní = 1.000 g.
          { item_id: 1, quantity: 1 },
        ],
        'DEDUCT',
      );
      expect(h.stockOf(1)).toBe(3990);
      // Un solo movimiento agregado para el mismo base.
      expect(h.movements.filter((m) => Number(m.product_id) === 1)).toHaveLength(1);
    });
  });
});
