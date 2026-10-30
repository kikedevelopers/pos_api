import type { DataSource } from 'typeorm';

import {
  availableStock,
  SellerToolRunner,
  type SellerToolContext,
} from '../internal/seller-tool-runner';

const context: SellerToolContext = {
  companyId: 7,
  channel: 'telegram',
  chatId: '999',
  chatDisplayName: 'María',
};

const makeRunner = (queryImpl: jest.Mock) =>
  new SellerToolRunner({ query: queryImpl } as unknown as DataSource);

describe('SellerToolRunner · search_products', () => {
  it('rechaza búsqueda vacía sin tocar la base', async () => {
    const query = jest.fn();
    const runner = makeRunner(query);
    const result = await runner.execute({ name: 'search_products', args: {} }, context);
    expect(result.response).toMatchObject({ error: expect.any(String) });
    expect(query).not.toHaveBeenCalled();
  });

  const familyRow = (overrides: Record<string, unknown> = {}) => ({
    family_id: '10',
    family_name: 'UVA PASA CJ X 10K',
    name: 'UVA PASA X LIBRA',
    sku_code: null,
    bar_code: null,
    parent_id: '10',
    stock: '0',
    parent_stock: '95650',
    category: 'Frutos secos',
    packaging: 'Libra',
    packaging_value: '500',
    prices: [{ name: '', sale_price: '8000' }],
    ...overrides,
  });

  it('agrupa por familia: el base y TODAS sus presentaciones, SIN exponer costo', async () => {
    const query = jest.fn().mockResolvedValue([
      familyRow({
        name: 'UVA PASA CJ X 10K',
        parent_id: null,
        stock: '95650',
        parent_stock: null,
        packaging: 'Caja',
        packaging_value: '10000',
        prices: [{ name: '', sale_price: '113000' }],
      }),
      familyRow(),
      familyRow({
        name: 'UVA PASA X MEDIA LIBRA 1/2',
        packaging_value: '250',
        prices: [{ name: '', sale_price: '4200' }],
      }),
      familyRow({
        family_id: '20',
        family_name: 'GRANOLA X 250g',
        name: 'GRANOLA X 250g',
        parent_id: null,
        stock: '12',
        parent_stock: null,
        packaging: null,
        packaging_value: null,
        prices: [{ name: 'Base', sale_price: '5500' }],
      }),
    ]);
    const runner = makeRunner(query);
    const result = await runner.execute(
      { name: 'search_products', args: { query: 'uva', limit: 5 } },
      context,
    );
    const response = result.response as {
      count: number;
      families: Array<{ product: string; presentations: Array<Record<string, unknown>> }>;
    };
    expect(response.count).toBe(2);
    expect(response.families[0].product).toBe('UVA PASA CJ X 10K');
    expect(response.families[0].presentations.map((p) => p.name)).toEqual([
      'UVA PASA CJ X 10K',
      'UVA PASA X LIBRA',
      'UVA PASA X MEDIA LIBRA 1/2',
    ]);
    expect(response.families[0].presentations[1]).toMatchObject({
      prices: [{ name: '', salePrice: 8000 }],
    });
    for (const family of response.families) {
      for (const presentation of family.presentations) {
        expect(Object.keys(presentation)).not.toContain('cost');
        for (const price of presentation.prices as Array<Record<string, unknown>>) {
          expect(Object.keys(price)).toEqual(['name', 'salePrice']);
        }
      }
    }
    expect(result.order).toBeUndefined();
  });

  it('la consulta expande la familia completa (base + presentaciones) de cada coincidencia', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await makeRunner(query).execute({ name: 'search_products', args: { query: 'uva' } }, context);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/WITH matched AS/);
    expect(sql).toMatch(/COALESCE\(p\.parent_id, p\.id\)/);
  });

  it('prioriza los productos cuyo nombre EMPIEZA por lo buscado', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await makeRunner(query).execute(
      { name: 'search_products', args: { query: 'Uva Pasa' } },
      context,
    );
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY BOOL_OR\(/);
    expect(params[params.length - 1]).toBe('uva pasa%');
    expect(params).toContain('%uva pasa%');
  });

  it('acota el número de familias a 1..15 (default 8)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const runner = makeRunner(query);
    await runner.execute({ name: 'search_products', args: { query: 'x' } }, context);
    await runner.execute({ name: 'search_products', args: { query: 'x', limit: 99 } }, context);
    const params0 = query.mock.calls[0][1] as unknown[];
    const params1 = query.mock.calls[1][1] as unknown[];
    expect(params0[params0.length - 3]).toBe(8);
    expect(params1[params1.length - 3]).toBe(15);
  });
});

describe('availableStock (existencias en la unidad de la presentación)', () => {
  it('una presentación lee el stock del base dividido por su empaque', () => {
    expect(
      availableStock({
        parent_id: '10',
        stock: '0',
        parent_stock: '95650',
        packaging_value: '500',
      }),
    ).toBe(191.3);
  });

  it('un base con empaque divide su propio stock', () => {
    expect(
      availableStock({
        parent_id: null,
        stock: '95650',
        parent_stock: null,
        packaging_value: '10000',
      }),
    ).toBe(9.56);
  });

  it('sin empaque (o empaque 0) devuelve el stock tal cual', () => {
    expect(
      availableStock({ parent_id: null, stock: '12', parent_stock: null, packaging_value: null }),
    ).toBe(12);
    expect(
      availableStock({ parent_id: null, stock: '12', parent_stock: null, packaging_value: '0' }),
    ).toBe(12);
  });

  it('redondea hacia abajo (nunca promete de más)', () => {
    expect(
      availableStock({ parent_id: '1', stock: '0', parent_stock: '999', packaging_value: '500' }),
    ).toBe(1.99);
  });

  it('stock negativo del base se refleja como agotado (negativo)', () => {
    expect(
      availableStock({ parent_id: '1', stock: '0', parent_stock: '-100', packaging_value: '50' }),
    ).toBe(-2);
  });
});

describe('SellerToolRunner · submit_order', () => {
  const runner = makeRunner(jest.fn());

  it('calcula subtotales y total, y emite el pedido para el dueño', async () => {
    const result = await runner.execute(
      {
        name: 'submit_order',
        args: {
          items: [
            { name: 'Arroz x libra', quantity: 2, unit_price: 3000 },
            { name: 'Aceite 1L', quantity: 1, unit_price: 12000 },
          ],
          customer_name: 'María',
          customer_phone: '3001234567',
        },
      },
      context,
    );

    expect(result.order).toBeDefined();
    expect(result.order?.total).toBe(18000);
    expect(result.order?.items[0]).toMatchObject({ line_total: 6000 });
    expect(result.order?.channel).toBe('telegram');
    expect(result.order?.chat_id).toBe('999');
    expect(result.response).toMatchObject({ status: 'taken', total: 18000 });
  });

  it('descarta líneas inválidas (cantidad 0 o sin nombre)', async () => {
    const result = await runner.execute(
      {
        name: 'submit_order',
        args: {
          items: [
            { name: 'Bueno', quantity: 1, unit_price: 1000 },
            { name: '', quantity: 3, unit_price: 500 },
            { name: 'Malo', quantity: 0, unit_price: 500 },
          ],
        },
      },
      context,
    );
    expect(result.order?.items).toHaveLength(1);
    expect(result.order?.total).toBe(1000);
  });

  it('sin líneas válidas devuelve "invalid" y NO emite pedido', async () => {
    const result = await runner.execute(
      { name: 'submit_order', args: { items: [{ name: '', quantity: 0, unit_price: 0 }] } },
      context,
    );
    expect(result.order).toBeUndefined();
    expect(result.response).toMatchObject({ status: 'invalid' });
  });
});

describe('SellerToolRunner · herramienta desconocida', () => {
  it('devuelve un error legible', async () => {
    const runner = makeRunner(jest.fn());
    const result = await runner.execute({ name: 'borrar_todo' }, context);
    expect(result.response).toMatchObject({ error: expect.stringContaining('borrar_todo') });
  });
});

describe('SellerToolRunner · política de stock', () => {
  const productRow = {
    family_id: '1',
    family_name: 'Arroz Diana x libra',
    name: 'Arroz Diana x libra',
    sku_code: 'ARZ-500',
    bar_code: '770123',
    parent_id: null,
    stock: '0',
    parent_stock: null,
    category: 'Granos',
    packaging: 'Libra',
    packaging_value: null,
    units: '12',
    prices: [{ name: 'Base', sale_price: '3000' }],
  };
  type SearchResponse = {
    families: Array<{ presentations: Array<Record<string, unknown>> }>;
    note: string;
  };

  it('inform (default): search_products entrega el stock y pide aclarar disponibilidad', async () => {
    const runner = makeRunner(jest.fn().mockResolvedValue([productRow]));
    const result = await runner.execute(
      { name: 'search_products', args: { query: 'arroz' } },
      context,
    );
    const response = result.response as SearchResponse;
    expect(response.families[0].presentations[0]).toHaveProperty('stock', 0);
    expect(response.note).toMatch(/no ofrezcas como disponible lo que no hay/);
  });

  it('offer_always: search_products NO entrega el stock y pide no hablar de existencias', async () => {
    const runner = makeRunner(jest.fn().mockResolvedValue([productRow]));
    const result = await runner.execute(
      { name: 'search_products', args: { query: 'arroz' } },
      { ...context, stockPolicy: 'offer_always' },
    );
    const response = result.response as SearchResponse;
    expect(response.families[0].presentations[0]).not.toHaveProperty('stock');
    expect(response.families[0].presentations[0]).toHaveProperty('prices');
    expect(response.note).toMatch(/NO hables de existencias/);
  });

  it('inform: get_popular_products filtra los agotados mirando el stock del base', async () => {
    const query = jest.fn().mockResolvedValue([productRow]);
    const runner = makeRunner(query);
    await runner.execute({ name: 'get_popular_products', args: {} }, context);
    expect(query.mock.calls[0][0]).toContain('COALESCE(parent.stock, p.stock) > 0');
  });

  it('inform: get_popular_products da el stock de una presentación desde su base', async () => {
    const row = { ...productRow, parent_id: '5', parent_stock: '1000', packaging_value: '250' };
    const runner = makeRunner(jest.fn().mockResolvedValue([row]));
    const result = await runner.execute({ name: 'get_popular_products', args: {} }, context);
    const response = result.response as { products: Array<Record<string, unknown>> };
    expect(response.products[0]).toHaveProperty('stock', 4);
  });

  it('offer_always: get_popular_products incluye agotados y oculta el stock', async () => {
    const query = jest.fn().mockResolvedValue([productRow]);
    const runner = makeRunner(query);
    const result = await runner.execute(
      { name: 'get_popular_products', args: {} },
      { ...context, stockPolicy: 'offer_always' },
    );
    expect(query.mock.calls[0][0]).not.toContain('COALESCE(parent.stock, p.stock) > 0');
    const response = result.response as { products: Array<Record<string, unknown>>; note: string };
    expect(response.products[0]).not.toHaveProperty('stock');
    expect(response.note).toMatch(/No hables de existencias/);
  });
});
