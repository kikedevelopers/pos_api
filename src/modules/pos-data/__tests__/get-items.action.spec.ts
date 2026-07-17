import type { DataSource } from 'typeorm';

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
    packaging__is_auto: false,
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
        packaging: { id: 5, name: 'Caja x 12', value: 12, is_auto: false },
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
        packaging__is_auto: null,
        packaging_id: null,
        prices: [],
      }),
    ]);
    const [item] = await action.execute(42);
    expect(item.packaging).toBeNull();
    expect(item.prices).toEqual([]);
  });

  /**
   * Los empaques "auto" (peso/monto variable) llevan un UUID como `name`. El POS
   * necesita `is_auto` para mostrar "Peso variable" en vez del UUID, así que la
   * bandera tiene que sobrevivir el mapeo. Datos reales del producto
   * "FENOGRECO MOLIDO PQ. $2 000" (packaging auto, value 44.44).
   */
  describe('packaging.is_auto', () => {
    it('propaga is_auto=true de un empaque auto junto a su value', async () => {
      const action = makeAction([
        rawRow({
          packaging__id: '2965',
          packaging__name: '56afeb68-a57e-424d-82d1-5f01ad2cb0b6',
          packaging__value: '44.4400',
          packaging__is_auto: true,
        }),
      ]);
      const [item] = await action.execute(42);

      expect(item.packaging).toEqual({
        id: 2965,
        name: '56afeb68-a57e-424d-82d1-5f01ad2cb0b6',
        value: 44.44,
        is_auto: true,
      });
    });

    it('normaliza is_auto ausente/null a false (empaque manual)', async () => {
      const action = makeAction([rawRow({ packaging__is_auto: null })]);
      const [item] = await action.execute(42);

      expect(item.packaging?.is_auto).toBe(false);
    });

    it('nunca devuelve is_auto undefined cuando hay empaque', async () => {
      const action = makeAction([rawRow({ packaging__is_auto: undefined })]);
      const [item] = await action.execute(42);

      expect(item.packaging?.is_auto).toBe(false);
    });
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
