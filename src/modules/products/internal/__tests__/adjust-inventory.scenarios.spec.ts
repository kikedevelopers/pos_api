import type { EntityManager } from 'typeorm';

import { adjustInventory, type InventoryLineItem } from '../adjust-inventory.helper';
import { computeStockDisplay, computeChildStockDisplay } from '../compute-stock-display';

/**
 * Escenarios de negocio EXACTOS (los del usuario), paridad con placepos
 * (`inventoryUtils.test.ts`). El stock vive en el padre en unidad mínima; toda
 * línea descuenta/devuelve `qty × packaging_value(congelado)` sobre
 * `parent_id ?? id`. Las presentaciones muestran `parentStock / su value`.
 *
 * A diferencia del harness de `adjust-inventory.helper.spec.ts`, este MUTA el
 * stock sembrado en cada `update` para poder encadenar venta → nota
 * crédito/anulación y verificar la simetría (vuelta al stock exacto).
 */
describe('adjustInventory — escenarios de negocio (base + presentaciones)', () => {
  interface SeedProduct {
    id: number;
    name: string;
    stock: number;
    packaging_id: number | null;
    parent_id?: number | null;
  }

  function buildManager(opts: {
    products: SeedProduct[];
    packagings: Array<{ id: number; value: number }>;
    strict?: boolean;
  }) {
    const productById = new Map(opts.products.map((p) => [String(p.id), p]));
    const extractIds = (where: Record<string, unknown>): string[] =>
      (where.id as { _value?: string[] })?._value ?? [];

    const managerMock = {
      find: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown[]> => {
          const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const ids = extractIds(options.where);
          if (name === 'Product') {
            return Promise.resolve(
              ids
                .map((id) => productById.get(String(id)))
                .filter((p): p is SeedProduct => p !== undefined)
                .map((p) => ({
                  id: String(p.id),
                  parent_id: p.parent_id != null ? String(p.parent_id) : null,
                  packaging_id: p.packaging_id !== null ? String(p.packaging_id) : null,
                  name: p.name,
                })),
            );
          }
          if (name === 'Packaging') {
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
          // Devuelve el estado VIVO (mutado) de los productos lockeados.
          getMany: jest.fn(() =>
            Promise.resolve(
              opts.products.map((p) => ({ id: String(p.id), name: p.name, stock: p.stock })),
            ),
          ),
        })),
      })),
      findOne: jest.fn((entity: { name?: string } | string): Promise<unknown> => {
        const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (name === 'AppSetting') {
          return Promise.resolve({ value: opts.strict ? 'true' : 'false' });
        }
        return Promise.resolve(null);
      }),
      // Muta el seed para permitir encadenar operaciones (venta → devolución).
      update: jest.fn(
        (entity: { name?: string } | string, where: { id: string }, patch: { stock: number }) => {
          const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          if (name === 'Product') {
            const p = productById.get(String(where.id));
            if (p) p.stock = patch.stock;
          }
          return Promise.resolve({ affected: 1 });
        },
      ),
      insert: jest.fn(() => Promise.resolve({ identifiers: [] })),
    };

    const stockOf = (id: number): number => productById.get(String(id))!.stock;
    return { manager: managerMock as unknown as EntityManager, stockOf };
  }

  const COMPANY = 42;

  describe('TRISALSINA PQ x12 (base) + UNIDAD (presentación x1)', () => {
    const seed = () =>
      buildManager({
        products: [
          { id: 1, name: 'TRISALSINA PQ x12', stock: 120, packaging_id: 100, parent_id: null },
          { id: 2, name: 'TRISALSINA UNIDAD', stock: 0, packaging_id: 101, parent_id: 1 },
        ],
        packagings: [
          { id: 100, value: 12 },
          { id: 101, value: 1 },
        ],
      });

    it('vender 2 del BASE descuenta 2×12=24 → interno 96 (usuario ve 8); presentación 96', async () => {
      const { manager, stockOf } = seed();
      await adjustInventory(
        manager,
        COMPANY,
        [{ item_id: 1, quantity: 2, packaging_value: 12 }],
        'DEDUCT',
      );
      expect(stockOf(1)).toBe(96);
      expect(computeStockDisplay(96, 12)).toBe(8);
      expect(computeChildStockDisplay(96, 0, 1)).toBe(96);
    });

    it('luego vender 2 de la PRESENTACIÓN descuenta 2×1=2 → interno 94; base 7,8333', async () => {
      const { manager, stockOf } = seed();
      await adjustInventory(
        manager,
        COMPANY,
        [{ item_id: 1, quantity: 2, packaging_value: 12 }],
        'DEDUCT',
      );
      await adjustInventory(
        manager,
        COMPANY,
        [{ item_id: 2, quantity: 2, packaging_value: 1 }],
        'DEDUCT',
      );
      expect(stockOf(1)).toBe(94);
      expect(computeStockDisplay(94, 12)).toBe(7.8333);
      expect(computeChildStockDisplay(94, 0, 1)).toBe(94);
    });
  });

  describe('UVA PASA: CAJA x10000 (base) + LIBRA x500 + MEDIA x250', () => {
    const seed = () =>
      buildManager({
        products: [
          { id: 1, name: 'UVA PASA CAJA x10K', stock: 40000, packaging_id: 200, parent_id: null },
          { id: 2, name: 'UVA PASA LIBRA', stock: 0, packaging_id: 201, parent_id: 1 },
          { id: 3, name: 'UVA PASA MEDIA', stock: 0, packaging_id: 202, parent_id: 1 },
        ],
        packagings: [
          { id: 200, value: 10000 },
          { id: 201, value: 500 },
          { id: 202, value: 250 },
        ],
      });

    it('estado inicial: base 4, libra 80, media 160', () => {
      expect(computeStockDisplay(40000, 10000)).toBe(4);
      expect(computeChildStockDisplay(40000, 0, 500)).toBe(80);
      expect(computeChildStockDisplay(40000, 0, 250)).toBe(160);
    });

    it('vender 1 del BASE descuenta 10000 → interno 30000 (usuario ve 3)', async () => {
      const { manager, stockOf } = seed();
      await adjustInventory(
        manager,
        COMPANY,
        [{ item_id: 1, quantity: 1, packaging_value: 10000 }],
        'DEDUCT',
      );
      expect(stockOf(1)).toBe(30000);
      expect(computeStockDisplay(30000, 10000)).toBe(3);
    });

    it('vender 5 de LIBRA descuenta 2500 → interno 37500; base 3,75, libra 75, media 150', async () => {
      const { manager, stockOf } = seed();
      await adjustInventory(
        manager,
        COMPANY,
        [{ item_id: 2, quantity: 5, packaging_value: 500 }],
        'DEDUCT',
      );
      expect(stockOf(1)).toBe(37500);
      expect(computeStockDisplay(37500, 10000)).toBe(3.75);
      expect(computeChildStockDisplay(37500, 0, 500)).toBe(75);
      expect(computeChildStockDisplay(37500, 0, 250)).toBe(150);
    });
  });

  describe('simetría venta ↔ nota crédito/anulación', () => {
    it('vender base + presentación y ANULAR (RETURN) deja el stock idéntico', async () => {
      const { manager, stockOf } = buildManager({
        products: [
          { id: 1, name: 'A', stock: 120, packaging_id: 100, parent_id: null },
          { id: 2, name: 'AB', stock: 0, packaging_id: 101, parent_id: 1 },
        ],
        packagings: [
          { id: 100, value: 12 },
          { id: 101, value: 1 },
        ],
      });
      const lines: InventoryLineItem[] = [
        { item_id: 1, quantity: 2, packaging_value: 12 },
        { item_id: 2, quantity: 5, packaging_value: 1 },
      ];
      await adjustInventory(manager, COMPANY, lines, 'DEDUCT');
      expect(stockOf(1)).toBe(91); // 120 − 29
      await adjustInventory(manager, COMPANY, lines, 'RETURN');
      expect(stockOf(1)).toBe(120); // exacto
    });

    it('anulación PARCIAL devuelve solo lo indicado con el factor congelado', async () => {
      const { manager, stockOf } = buildManager({
        products: [
          { id: 1, name: 'UVA PASA', stock: 40000, packaging_id: 200, parent_id: null },
          { id: 2, name: 'LIBRA', stock: 0, packaging_id: 201, parent_id: 1 },
        ],
        packagings: [
          { id: 200, value: 10000 },
          { id: 201, value: 500 },
        ],
      });
      await adjustInventory(
        manager,
        COMPANY,
        [{ item_id: 2, quantity: 5, packaging_value: 500 }],
        'DEDUCT',
      );
      expect(stockOf(1)).toBe(37500);
      await adjustInventory(
        manager,
        COMPANY,
        [{ item_id: 2, quantity: 2, packaging_value: 500 }],
        'RETURN',
      );
      expect(stockOf(1)).toBe(38500); // quedan vendidas 3 libras (1500)
    });

    it('simetría con packaging congelado aunque cambie el empaque vigente entre cobro y anulación', async () => {
      const { manager, stockOf } = buildManager({
        products: [{ id: 1, name: 'A', stock: 120, packaging_id: 100, parent_id: null }],
        packagings: [{ id: 100, value: 12 }],
      });
      const line: InventoryLineItem = { item_id: 1, quantity: 2, packaging_value: 12 };
      await adjustInventory(manager, COMPANY, [line], 'DEDUCT');
      expect(stockOf(1)).toBe(96);
      // El RETURN lleva el snapshot congelado (12), no el vigente; simétrico.
      await adjustInventory(manager, COMPANY, [line], 'RETURN');
      expect(stockOf(1)).toBe(120);
    });
  });
});
