import type { EntityManager } from 'typeorm';

import { adjustInventory, type InventoryLineItem } from '../adjust-inventory.helper';

/**
 * Tests de la semántica de `packaging_value` en `adjustInventory`.
 *
 * El helper está pensado para VENTAS, donde la cantidad de la línea llega en
 * unidad de venta y debe convertirse a la unidad mínima multiplicando por el
 * `packaging_value` del producto. En COMPRAS la cantidad (`unit_qty`) ya está
 * en unidad mínima (el embalaje es solo informativo), así que los flujos de
 * compra pasan `packaging_value: 1` para neutralizar esa multiplicación.
 *
 * Estos tests blindan ESE contrato: sin override el helper multiplica por el
 * packaging del producto; con `packaging_value: 1` aplica la cantidad cruda.
 */
describe('adjustInventory — semántica de packaging_value', () => {
  interface SeedProduct {
    id: number;
    name: string;
    stock: number;
    packaging_id: number | null;
    parent_id?: number | null;
  }

  interface ManagerHarness {
    manager: EntityManager;
    updates: Array<{ id: string; stock: number }>;
    movements: Array<Record<string, unknown>>;
  }

  function buildManager(opts: {
    products: SeedProduct[];
    packagings: Array<{ id: number; value: number }>;
    strict?: boolean;
  }): ManagerHarness {
    const updates: Array<{ id: string; stock: number }> = [];
    const movements: Array<Record<string, unknown>> = [];
    const productById = new Map(opts.products.map((p) => [String(p.id), p]));

    const extractIds = (where: Record<string, unknown>): string[] =>
      (where.id as { _value?: string[] })?._value ?? [];

    const managerMock = {
      find: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown[]> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const ids = extractIds(options.where);
          if (entityName === 'Product') {
            return Promise.resolve(
              ids
                .map((id) => productById.get(String(id)))
                .filter((p): p is SeedProduct => p !== undefined)
                .map((p) => ({
                  id: String(p.id),
                  parent_id: p.parent_id ?? null,
                  packaging_id: p.packaging_id !== null ? String(p.packaging_id) : null,
                  name: p.name,
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
          getMany: jest
            .fn()
            .mockResolvedValue(
              opts.products.map((p) => ({ id: String(p.id), name: p.name, stock: p.stock })),
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
            updates.push({ id: where.id, stock: patch.stock });
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

    return { manager: managerMock as unknown as EntityManager, updates, movements };
  }

  it('DEDUCT sin packaging_value multiplica por el packaging del producto (caso VENTA)', async () => {
    const { manager, updates, movements } = buildManager({
      products: [{ id: 10, name: 'Arroz granel', stock: 50000, packaging_id: 5 }],
      packagings: [{ id: 5, value: 1000 }],
    });

    const lines: InventoryLineItem[] = [{ item_id: 10, quantity: 2 }];
    await adjustInventory(manager, 42, lines, 'DEDUCT');

    // 2 (unidad de venta) × 1000 (packaging_value) = 2000 en unidad mínima.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.stock).toBe(48000);
    expect(movements[0]?.quantity).toBe(2000);
    expect(movements[0]?.direction).toBe('OUT');
  });

  it('DEDUCT con packaging_value:1 NO multiplica: aplica la cantidad cruda (caso COMPRA)', async () => {
    const { manager, updates, movements } = buildManager({
      products: [{ id: 10, name: 'Arroz granel', stock: 50000, packaging_id: 5 }],
      packagings: [{ id: 5, value: 1000 }],
    });

    // unit_qty ya está en unidad mínima: 20000 ("20 kilos" informativos).
    const lines: InventoryLineItem[] = [{ item_id: 10, quantity: 20000, packaging_value: 1 }];
    await adjustInventory(manager, 42, lines, 'DEDUCT');

    // Con el fix: 20000 × 1 = 20000 → 50000 - 20000 = 30000.
    // (Sin el fix habría restado 20000 × 1000 = 20.000.000, corrompiendo el stock.)
    expect(updates).toHaveLength(1);
    expect(updates[0]?.stock).toBe(30000);
    expect(movements[0]?.quantity).toBe(20000);
    expect(movements[0]?.direction).toBe('OUT');
  });

  it('RETURN con packaging_value:1 suma exactamente la cantidad cruda (caso COMPRA)', async () => {
    const { manager, updates, movements } = buildManager({
      products: [{ id: 10, name: 'Arroz granel', stock: 30000, packaging_id: 5 }],
      packagings: [{ id: 5, value: 1000 }],
    });

    const lines: InventoryLineItem[] = [{ item_id: 10, quantity: 20000, packaging_value: 1 }];
    await adjustInventory(manager, 42, lines, 'RETURN');

    // 30000 + 20000 = 50000 (revierte/edita lo que sumó la recepción).
    expect(updates[0]?.stock).toBe(50000);
    expect(movements[0]?.quantity).toBe(20000);
    expect(movements[0]?.direction).toBe('IN');
  });

  it('recepción y reversión son simétricas con packaging_value:1 (ciclo neto = 0)', async () => {
    // Recepción: suma 20000 directo (mark-purchase-received hace stock += unit_qty).
    const recibido = 50000 + 20000; // 70000

    // Reversión vía adjustInventory con packaging_value:1.
    const { manager, updates } = buildManager({
      products: [{ id: 10, name: 'Arroz granel', stock: recibido, packaging_id: 5 }],
      packagings: [{ id: 5, value: 1000 }],
    });
    await adjustInventory(
      manager,
      42,
      [{ item_id: 10, quantity: 20000, packaging_value: 1 }],
      'DEDUCT',
    );

    // Vuelve al stock previo a la compra: sin doble multiplicación.
    expect(updates[0]?.stock).toBe(50000);
  });
});
