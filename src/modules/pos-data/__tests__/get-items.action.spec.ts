import type { DataSource } from 'typeorm';

import { GetItemsAction } from '../actions/get-items.action';

/**
 * Garantiza la EQUIVALENCIA tras migrar el fetch del POS a SQL crudo:
 * el post-proceso JS (parentMap, childrenByParent, orden, stock mostrado)
 * opera sobre objetos planos con la MISMA forma de antes.
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
    product_type: 'SIMPLE',
    show_in_pos: true,
    created_at: new Date('2026-05-12T14:30:00.000Z'),
    stock: '10.0000',
    image: null,
    description: null,
    packaging__id: '5',
    packaging__name: 'Caja x 12',
    packaging__value: '12.0000',
    packaging__is_auto: false,
    prices: [{ id: 100, sale_price: 10.5, profit: 8, margin: 76.1905 }],
    ...over,
  };
}

/**
 * Filas de `combo_components` que verá el loader de recetas. `manager.find`
 * filtra por la company dueña y por los ids pedidos, igual que la query real,
 * para que un combo compartido no cuele su receta bajo otra company.
 */
interface FakeComboRow {
  company_id: string;
  combo_product_id: string;
  component_product_id: string;
  quantity: number;
  component: {
    name: string;
    cost: number;
    stock: number;
    is_archived: boolean;
    packaging: { id: string; name: string; value: number } | null;
  };
}

function makeAction(
  rows: Record<string, unknown>[],
  comboRows: FakeComboRow[] = [],
): GetItemsAction {
  const dataSource = {
    query: jest.fn().mockResolvedValue(rows),
    manager: {
      find: jest.fn((_entity: unknown, options: { where: Record<string, unknown> }) => {
        const where = options.where as {
          company_id: string;
          combo_product_id: { value?: string[] } | string;
        };
        // `In([...])` expone los ids en `.value`; un id suelto llega plano.
        const wanted =
          typeof where.combo_product_id === 'string'
            ? [where.combo_product_id]
            : (where.combo_product_id.value ?? []);
        return Promise.resolve(
          comboRows.filter(
            (r) => r.company_id === where.company_id && wanted.includes(r.combo_product_id),
          ),
        );
      }),
    },
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
        product_type: 'SIMPLE',
        packaging: { id: 5, name: 'Caja x 12', value: 12, is_auto: false },
        prices: [{ id: 100, sale_price: 10.5, profit: 8, margin: 76.1905 }],
        // Base con empaque: stock_display = 10 / 12 (misma fórmula del inventario).
        stock: 0.8333,
        parent: null,
        // FASE 2 (COMPARTIR): producto propio (company_id == activa).
        is_shared: false,
        owner_company_id: 42,
        // Imagen: la action solo proyecta la RUTA. La URL firmada la resuelve
        // `PosDataService` en lote contra el caché, por eso viaja en null.
        image: null,
        image_url: null,
        description: null,
      },
    ]);
  });

  it('proyecta la ruta de la imagen y deja la URL para el lote del service', async () => {
    const action = makeAction([rawRow({ image: 'inventory_items/42/10-abc.jpg' })]);
    const [item] = await action.execute(42);

    expect(item.image).toBe('inventory_items/42/10-abc.jpg');
    expect(item.image_url).toBeNull();
  });

  it('proyecta la descripción del producto', async () => {
    const action = makeAction([rawRow({ description: 'Bebida gaseosa sabor cola.' })]);
    const [item] = await action.execute(42);

    expect(item.description).toBe('Bebida gaseosa sabor cola.');
  });

  it('descripción ausente llega en null (no undefined)', async () => {
    const action = makeAction([rawRow({ description: undefined })]);
    const [item] = await action.execute(42);

    expect(item.description).toBeNull();
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
    // `parent.stock` va CRUDO: el caché optimista del POS reparte desde ahí.
    expect(items[1].parent).toEqual({ id: 1, name: 'Coca-Cola 2L', stock: 10, cost: 2.5 });
    // Presentación: stock del PADRE (10) / packaging_value del HIJO (12).
    expect(items[1].stock).toBe(0.8333);
  });

  it('la descripción de un hijo es la suya, no la del padre', async () => {
    const action = makeAction([
      rawRow({ id: '1', parent_id: null, description: 'Descripción del padre' }),
      rawRow({ id: '2', parent_id: '1', show_in_pos: true, description: 'Descripción del hijo' }),
    ]);
    const items = await action.execute(42);
    expect(items[0].description).toBe('Descripción del padre');
    expect(items[1].description).toBe('Descripción del hijo');
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

  /**
   * El POS etiqueta la tarjeta con `product_type`. Sin este campo en el payload
   * un COMBO se mostraba como "Base" (la UI solo miraba `parent_id`, que en un
   * combo es null igual que en un base).
   */
  describe('product_type', () => {
    it('propaga COMBO en un producto raíz', async () => {
      const action = makeAction([
        rawRow({ id: '9', name: 'UVA PASA Y MANI', product_type: 'COMBO', packaging_id: null }),
      ]);
      const [item] = await action.execute(42);
      expect(item.product_type).toBe('COMBO');
    });

    it('propaga el tipo de las presentaciones sin heredar el del padre', async () => {
      const action = makeAction([
        rawRow({
          id: '1',
          product_type: 'COMBO',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        }),
        rawRow({
          id: '2',
          parent_id: '1',
          product_type: 'SIMPLE',
          created_at: new Date('2026-01-02T00:00:00.000Z'),
        }),
      ]);
      const items = await action.execute(42);
      expect(items.map((i) => [i.id, i.product_type])).toEqual([
        [1, 'COMBO'],
        [2, 'SIMPLE'],
      ]);
    });

    it('degrada a SIMPLE si la fila llega sin tipo (dump antiguo)', async () => {
      const action = makeAction([rawRow({ product_type: null })]);
      const [item] = await action.execute(42);
      expect(item.product_type).toBe('SIMPLE');
    });
  });

  /**
   * El POS y el inventario DEBEN mostrar la misma cifra. Durante mucho tiempo
   * este action devolvía `stock: 0` en todos los items (un TODO que sobrevivió
   * a la llegada de la columna `stock`), así que la pantalla de venta enseñaba
   * todo agotado mientras el inventario mostraba existencias reales.
   *
   * Las tres reglas son las de `toProductResponseDto`.
   */
  describe('stock mostrado', () => {
    function comboRow(over: Partial<FakeComboRow> = {}): FakeComboRow {
      return {
        company_id: '42',
        combo_product_id: '9',
        component_product_id: '100',
        quantity: 25,
        component: {
          name: 'MANI CON SAL',
          cost: 12000,
          stock: 3000,
          is_archived: false,
          packaging: { id: '1', name: 'KILO', value: 1000 },
        },
        ...over,
      };
    }

    it('base sin empaque: devuelve el stock crudo', async () => {
      const action = makeAction([
        rawRow({
          stock: '6.0000',
          packaging_id: null,
          packaging__id: null,
          packaging__value: null,
        }),
      ]);
      const [item] = await action.execute(42);
      expect(item.stock).toBe(6);
    });

    it('base con empaque: stock / packaging.value', async () => {
      const action = makeAction([rawRow({ stock: '3000.0000', packaging__value: '1000' })]);
      const [item] = await action.execute(42);
      expect(item.stock).toBe(3);
    });

    it('presentación: stock del PADRE / packaging_value del HIJO', async () => {
      const action = makeAction([
        rawRow({
          id: '1',
          stock: '3000.0000',
          packaging__value: '453.6',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        }),
        rawRow({
          id: '2',
          parent_id: '1',
          // El stock propio del hijo es ruido: no debe entrar en el cálculo.
          stock: '999.0000',
          packaging__value: '1',
          created_at: new Date('2026-01-02T00:00:00.000Z'),
        }),
      ]);
      const items = await action.execute(42);
      expect(items[1].stock).toBe(3000);
    });

    it('presentación sin empaque: cae al stock crudo del hijo', async () => {
      const action = makeAction([
        rawRow({ id: '1', stock: '500.0000', created_at: new Date('2026-01-01T00:00:00.000Z') }),
        rawRow({
          id: '2',
          parent_id: '1',
          stock: '7.0000',
          packaging_id: null,
          packaging__id: null,
          packaging__value: null,
          created_at: new Date('2026-01-02T00:00:00.000Z'),
        }),
      ]);
      const items = await action.execute(42);
      expect(items[1].stock).toBe(7);
    });

    it('propaga stock NEGATIVO sin recortarlo a 0', async () => {
      const action = makeAction([
        rawRow({
          stock: '-330.0000',
          packaging_id: null,
          packaging__id: null,
          packaging__value: null,
        }),
      ]);
      const [item] = await action.execute(42);
      expect(item.stock).toBe(-330);
    });

    it('combo: unidades armables con la receta, no su stock propio', async () => {
      const action = makeAction(
        [
          rawRow({
            id: '9',
            name: 'UVA PASA Y MANI',
            product_type: 'COMBO',
            // Un combo no tiene stock propio; si la columna trajera basura, se ignora.
            stock: '777.0000',
            packaging_id: null,
            packaging__id: null,
            packaging__value: null,
          }),
        ],
        // 3000 g de maní, receta de 25 g → 120 combos armables.
        [comboRow()],
      );
      const [item] = await action.execute(42);
      expect(item.stock).toBe(120);
    });

    it('combo: manda el componente MÁS escaso', async () => {
      const action = makeAction(
        [
          rawRow({
            id: '9',
            product_type: 'COMBO',
            packaging_id: null,
            packaging__id: null,
            packaging__value: null,
          }),
        ],
        [
          comboRow(),
          comboRow({
            component_product_id: '200',
            quantity: 50,
            // 400 g / 50 g = 8 combos: este es el techo.
            component: {
              name: 'UVA PASA',
              cost: 20000,
              stock: 400,
              is_archived: false,
              packaging: { id: '1', name: 'KILO', value: 1000 },
            },
          }),
        ],
      );
      const [item] = await action.execute(42);
      expect(item.stock).toBe(8);
    });

    it('combo sin receta: 0 (no se puede armar nada)', async () => {
      const action = makeAction(
        [
          rawRow({
            id: '9',
            product_type: 'COMBO',
            stock: '500.0000',
            packaging_id: null,
            packaging__id: null,
            packaging__value: null,
          }),
        ],
        [],
      );
      const [item] = await action.execute(42);
      expect(item.stock).toBe(0);
    });

    it('combo compartido: busca la receta en la company DUEÑA, no en la activa', async () => {
      const action = makeAction(
        [
          rawRow({
            id: '9',
            product_type: 'COMBO',
            // Sucursal 42 viendo un combo del principal (company 7).
            company_id: '7',
            packaging_id: null,
            packaging__id: null,
            packaging__value: null,
          }),
        ],
        [comboRow({ company_id: '7' })],
      );
      const [item] = await action.execute(42);
      expect(item.is_shared).toBe(true);
      expect(item.stock).toBe(120);
    });

    it('sin combos no consulta combo_components', async () => {
      const action = makeAction([rawRow()]);
      await action.execute(42);
      const manager = (action as unknown as { dataSource: { manager: { find: jest.Mock } } })
        .dataSource.manager;
      expect(manager.find).not.toHaveBeenCalled();
    });
  });
});
