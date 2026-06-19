import { DataSource } from 'typeorm';

import { GetItemsAction } from '../actions/get-items.action';

/**
 * Garantiza la EQUIVALENCIA tras migrar el fetch del POS a SQL crudo:
 * el post-proceso JS (parentMap, childrenByParent, orden, stock:0) opera
 * sobre objetos planos con la MISMA forma de antes.
 */

function rawRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '10',
    name: 'Coca-Cola 2L',
    cost: '2.50',
    bar_code: '7591001234567',
    sku_code: 'SKU-1',
    parent_id: null,
    // FASE 2 (COMPARTIR): el SQL del POS proyecta p.company_id como dueño.
    // Igual a la company activa del test (42) → producto propio, is_shared false.
    company_id: '42',
    packaging_id: '5',
    show_in_pos: true,
    created_at: new Date('2026-05-12T14:30:00.000Z'),
    stock: '10.0000',
    packaging__id: '5',
    packaging__name: 'Caja x 12',
    packaging__value: '12.0000',
    prices: [{ id: 100, sale_price: 10.5, profit: 8, margin: 76.1905 }],
    ...over,
  };
}

function makeAction(rows: Record<string, unknown>[]): GetItemsAction {
  const dataSource = {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as DataSource;
  return new GetItemsAction(dataSource);
}

describe('GetItemsAction (SQL crudo)', () => {
  it('expone el shape PosItem completo para un padre visible', async () => {
    const action = makeAction([rawRow()]);
    const items = await action.execute(42);

    expect(items).toEqual([
      {
        id: 10,
        name: 'Coca-Cola 2L',
        cost: 2.5,
        bar_code: '7591001234567',
        sku_code: 'SKU-1',
        parent_id: null,
        packaging_id: 5,
        packaging: { id: 5, name: 'Caja x 12', value: 12 },
        prices: [{ id: 100, sale_price: 10.5, profit: 8, margin: 76.1905 }],
        stock: 0, // placeholder Fase 11.5 — NO se toca.
        parent: null,
        // FASE 2 (COMPARTIR): producto propio (company_id == activa).
        is_shared: false,
        owner_company_id: 42,
      },
    ]);
  });

  it('packaging null y prices vacío con COALESCE', async () => {
    const action = makeAction([
      rawRow({
        packaging__id: null,
        packaging__name: null,
        packaging__value: null,
        packaging_id: null,
        prices: [],
      }),
    ]);
    const [item] = await action.execute(42);
    expect(item.packaging).toBeNull();
    expect(item.prices).toEqual([]);
  });

  it('coloca hijos visibles tras el padre y deriva su parent', async () => {
    const action = makeAction([
      rawRow({ id: '1', parent_id: null, created_at: new Date('2026-01-01T00:00:00.000Z') }),
      rawRow({
        id: '2',
        parent_id: '1',
        show_in_pos: true,
        created_at: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ]);
    const items = await action.execute(42);
    expect(items.map((i) => i.id)).toEqual([1, 2]);
    expect(items[1].parent).toEqual({ id: 1, name: 'Coca-Cola 2L', cost: 2.5 });
    // stock placeholder: floor(parent.stock(0) / packagingValue) = 0.
    expect(items[1].stock).toBe(0);
  });

  it('created_at string del driver se normaliza para el orden', async () => {
    const action = makeAction([
      rawRow({ id: '1', created_at: '2026-01-01T00:00:00.000Z' }),
      rawRow({ id: '2', created_at: '2026-03-01T00:00:00.000Z' }),
    ]);
    const items = await action.execute(42);
    // Padres ordenados por created_at DESC.
    expect(items.map((i) => i.id)).toEqual([2, 1]);
  });
});
