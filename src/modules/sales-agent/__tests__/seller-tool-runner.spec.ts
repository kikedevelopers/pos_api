import type { DataSource } from 'typeorm';

import { SellerToolRunner, type SellerToolContext } from '../internal/seller-tool-runner';

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

  it('mapea productos con stock y precios, SIN exponer costo', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        name: 'Arroz Diana x libra',
        sku_code: 'ARZ-500',
        bar_code: '770123',
        stock: '20',
        category: 'Granos',
        packaging: 'Libra',
        prices: [{ name: 'Base', sale_price: '3000' }],
      },
    ]);
    const runner = makeRunner(query);
    const result = await runner.execute(
      { name: 'search_products', args: { query: 'arroz', limit: 5 } },
      context,
    );
    const products = (result.response as { products: unknown[] }).products as Array<
      Record<string, unknown>
    >;
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      name: 'Arroz Diana x libra',
      stock: 20,
      prices: [{ name: 'Base', salePrice: 3000 }],
    });
    // Ningún producto ni su precio deben traer costo/margen al vendedor.
    const price = (products[0].prices as Array<Record<string, unknown>>)[0];
    expect(Object.keys(products[0])).not.toContain('cost');
    expect(Object.keys(price)).toEqual(['name', 'salePrice']);
    expect(result.order).toBeUndefined();
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
