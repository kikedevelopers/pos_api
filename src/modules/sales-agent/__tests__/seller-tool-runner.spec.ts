import type { DataSource } from 'typeorm';

import {
  availableStock,
  SellerToolRunner,
  type SellerToolContext,
} from '../internal/seller-tool-runner';
import type { SellerCartService } from '../seller-cart.service';
import type { CatalogSemanticService } from '@/modules/catalog-knowledge/catalog-semantic.service';
import { emptyCart, setCartItem } from '../internal/cart';
import Big from 'big.js';

const context: SellerToolContext = {
  companyId: 7,
  channel: 'telegram',
  chatId: '999',
  chatDisplayName: 'María',
};

const makeCart = () => ({
  setItem: jest.fn(),
  setDetails: jest.fn(),
  close: jest.fn(),
});

const makeSemantic = () => ({ search: jest.fn().mockResolvedValue([]) });

const makeRunner = (queryImpl: jest.Mock, cart = makeCart(), semantic = makeSemantic()) =>
  new SellerToolRunner(
    { query: queryImpl } as unknown as DataSource,
    cart as unknown as SellerCartService,
    semantic as unknown as CatalogSemanticService,
  );

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

describe('SellerToolRunner · pedido en curso', () => {
  const conversation = { companyId: 7, channel: 'telegram', chatId: '999' };
  const withConversation: SellerToolContext = { ...context, conversation };
  const cartWithArroz = () =>
    setCartItem(
      emptyCart(),
      { product_id: 5, name: 'ARROZ X LIBRA', unit_price: new Big(3000) },
      new Big(2),
    );

  it('sin conversación, las herramientas del pedido no están disponibles', async () => {
    const cart = makeCart();
    const runner = makeRunner(jest.fn(), cart);
    for (const name of ['set_cart_item', 'set_order_details', 'close_order']) {
      const result = await runner.execute({ name, args: { product_id: 5, quantity: 1 } }, context);
      expect(result.response).toMatchObject({ status: 'unavailable' });
    }
    expect(cart.setItem).not.toHaveBeenCalled();
    expect(cart.close).not.toHaveBeenCalled();
  });

  it('set_cart_item delega con el id y la cantidad, y devuelve el pedido y lo que falta', async () => {
    const cart = makeCart();
    cart.setItem.mockResolvedValue({ status: 'ok', cart: cartWithArroz() });
    const runner = makeRunner(jest.fn(), cart);

    const result = await runner.execute(
      { name: 'set_cart_item', args: { product_id: '5', quantity: 2 } },
      withConversation,
    );

    expect(cart.setItem).toHaveBeenCalledWith(conversation, 5, 2);
    expect(result.response).toMatchObject({
      status: 'ok',
      cart: {
        items: [{ product_id: 5, quantity: 2, unit_price: 3000, total: 6000 }],
        total: 6000,
        missing_to_close: ['dirección de entrega', 'nombre de quien recibe'],
      },
    });
    expect(result.order).toBeUndefined();
  });

  it('set_cart_item sin id válido no toca el pedido', async () => {
    const cart = makeCart();
    const runner = makeRunner(jest.fn(), cart);
    for (const product_id of [undefined, 0, -3, 'abc', 1.5]) {
      const result = await runner.execute(
        { name: 'set_cart_item', args: { product_id, quantity: 1 } },
        withConversation,
      );
      expect(result.response).toMatchObject({ status: 'invalid_product' });
    }
    expect(cart.setItem).not.toHaveBeenCalled();
  });

  it('set_cart_item propaga el motivo cuando el servicio lo rechaza', async () => {
    const cart = makeCart();
    cart.setItem.mockResolvedValue({ status: 'not_found', message: 'no disponible' });
    const result = await makeRunner(jest.fn(), cart).execute(
      { name: 'set_cart_item', args: { product_id: 9, quantity: 1 } },
      withConversation,
    );
    expect(result.response).toEqual({ status: 'not_found', message: 'no disponible' });
  });

  it('set_order_details guarda los datos y devuelve el pedido', async () => {
    const cart = makeCart();
    cart.setDetails.mockResolvedValue({ ...cartWithArroz(), details: { customer_name: 'Ana' } });
    const args = { customer_name: 'Ana', delivery_address: 'Cra 1' };
    const result = await makeRunner(jest.fn(), cart).execute(
      { name: 'set_order_details', args },
      withConversation,
    );
    expect(cart.setDetails).toHaveBeenCalledWith(conversation, args);
    expect(result.response).toMatchObject({
      status: 'ok',
      cart: { details: { customer_name: 'Ana' } },
    });
  });

  it('close_order cerrado: emite el pedido para AVISAR al dueño (sin venta)', async () => {
    const cart = makeCart();
    const order = {
      reference: 'P-ABC12345',
      items: [{ name: 'ARROZ X LIBRA', quantity: 2, unit_price: 3000, line_total: 6000 }],
      total: 6000,
      channel: 'telegram',
      chat_id: '999',
    };
    cart.close.mockResolvedValue({ status: 'closed', cart: emptyCart(), order });
    const runner = makeRunner(jest.fn(), cart);

    const result = await runner.execute(
      { name: 'close_order', args: {} },
      { ...withConversation, pickupAvailable: true },
    );

    expect(cart.close).toHaveBeenCalledWith(
      conversation,
      { pickupAvailable: true },
      { channel: 'telegram', chatId: '999', chatDisplayName: 'María' },
    );
    expect(result.order).toBe(order);
    expect(result.response).toMatchObject({
      status: 'closed',
      reference: 'P-ABC12345',
      total: 6000,
    });
    expect((result.response as { message: string }).message).toMatch(
      /NO digas que quedó "registrado/,
    );
  });

  it('close_order con datos faltantes no emite pedido y dice qué falta', async () => {
    const cart = makeCart();
    cart.close.mockResolvedValue({
      status: 'missing_data',
      cart: emptyCart(),
      missing: ['productos'],
    });
    const result = await makeRunner(jest.fn(), cart).execute(
      { name: 'close_order' },
      withConversation,
    );
    expect(result.order).toBeUndefined();
    expect(result.response).toMatchObject({ status: 'missing_data', missing: ['productos'] });
  });

  it('close_order con precio cambiado no emite pedido y devuelve el pedido actualizado', async () => {
    const cart = makeCart();
    cart.close.mockResolvedValue({
      status: 'price_changed',
      cart: cartWithArroz(),
      message: 'cambió',
    });
    const result = await makeRunner(jest.fn(), cart).execute(
      { name: 'close_order' },
      withConversation,
    );
    expect(result.order).toBeUndefined();
    expect(result.response).toMatchObject({ status: 'price_changed', cart: { total: 6000 } });
  });

  it('por defecto (sin dato del negocio) no se puede recoger', async () => {
    const cart = makeCart();
    cart.close.mockResolvedValue({ status: 'missing_data', cart: emptyCart(), missing: [] });
    await makeRunner(jest.fn(), cart).execute({ name: 'close_order' }, withConversation);
    expect(cart.close.mock.calls[0][1]).toEqual({ pickupAvailable: false });
  });
});

describe('SellerToolRunner · solo productos vendibles', () => {
  it('la búsqueda y las sugerencias filtran lo que el POS puede vender', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const runner = makeRunner(query);
    await runner.execute({ name: 'search_products', args: { query: 'arroz' } }, context);
    await runner.execute({ name: 'get_popular_products', args: {} }, context);
    for (const [sql] of query.mock.calls as Array<[string]>) {
      expect(sql).toContain('p.show_in_pos = true');
      expect(sql).toContain("p.product_type IN ('SIMPLE', 'COMBO')");
    }
  });

  it('cada presentación trae su id para armar el pedido', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: '48279',
        family_id: '48270',
        family_name: 'UVA PASA CJ X 10K',
        name: 'UVA PASA X LIBRA',
        sku_code: null,
        bar_code: null,
        parent_id: '48270',
        stock: '0',
        parent_stock: '1000',
        category: null,
        packaging: null,
        packaging_value: '500',
        prices: [{ name: '', sale_price: '8000' }],
      },
    ]);
    const result = await makeRunner(query).execute(
      { name: 'search_products', args: { query: 'uva' } },
      context,
    );
    const families = (
      result.response as { families: Array<{ presentations: Array<{ id: number }> }> }
    ).families;
    expect(families[0].presentations[0].id).toBe(48279);
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

describe('SellerToolRunner · búsqueda por necesidad y ficha del producto', () => {
  const j2Row = {
    id: '20',
    family_id: '20',
    family_name: 'CONTENEDOR J2',
    name: 'CONTENEDOR J2',
    sku_code: null,
    bar_code: null,
    parent_id: null,
    stock: '50',
    parent_stock: null,
    category: 'Desechables',
    packaging: null,
    packaging_value: null,
    prices: [{ name: 'Base', sale_price: '900' }],
    family_profile: {
      description: 'Contenedor con dos compartimentos',
      uses: ['hamburguesa con papas'],
      attributes: [{ name: 'compartimentos', value: '2' }],
      related: [{ id: '21', name: 'SALSA SOBRE', kind: 'complement' }],
    },
  };

  it('find_products_for_need busca por significado y arma las familias en ese orden', async () => {
    const semantic = makeSemantic();
    semantic.search.mockResolvedValue([
      { id: 20, score: 0.71 },
      { id: 10, score: 0.69 },
    ]);
    const query = jest.fn().mockResolvedValue([j2Row]);
    const runner = makeRunner(query, makeCart(), semantic);

    const result = await runner.execute(
      { name: 'find_products_for_need', args: { need: 'contenedor para hamburguesa y papas' } },
      context,
    );

    expect(semantic.search).toHaveBeenCalledWith(7, 'contenedor para hamburguesa y papas', 5);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/unnest\(\$\d+::bigint\[\]\) WITH ORDINALITY/);
    expect(params).toContainEqual(['20', '10']);
    const response = result.response as {
      count: number;
      families: Array<Record<string, unknown>>;
      note: string;
    };
    expect(response.count).toBe(1);
    expect(response.families[0]).toMatchObject({
      product: 'CONTENEDOR J2',
      profile: {
        description: 'Contenedor con dos compartimentos',
        uses: ['hamburguesa con papas'],
        attributes: [{ name: 'compartimentos', value: '2' }],
        related: [{ id: 21, name: 'SALSA SOBRE', kind: 'complement' }],
      },
    });
    expect(response.note).toMatch(/PARECIDO con la necesidad/);
  });

  it('sin coincidencias no consulta la BD y pide no inventar', async () => {
    const query = jest.fn();
    const result = await makeRunner(query).execute(
      { name: 'find_products_for_need', args: { need: 'repuestos de moto' } },
      context,
    );
    expect(query).not.toHaveBeenCalled();
    expect(result.response).toMatchObject({ count: 0, families: [] });
    expect((result.response as { note: string }).note).toMatch(/no inventes productos/);
  });

  it('sin necesidad devuelve error y no busca', async () => {
    const semantic = makeSemantic();
    const result = await makeRunner(jest.fn(), makeCart(), semantic).execute(
      { name: 'find_products_for_need', args: { need: '  ' } },
      context,
    );
    expect(result.response).toMatchObject({ error: expect.any(String) });
    expect(semantic.search).not.toHaveBeenCalled();
  });

  it('acota el límite a 1..10', async () => {
    const semantic = makeSemantic();
    const runner = makeRunner(jest.fn(), makeCart(), semantic);
    await runner.execute(
      { name: 'find_products_for_need', args: { need: 'x', limit: 50 } },
      context,
    );
    expect(semantic.search).toHaveBeenCalledWith(7, 'x', 10);
  });

  it('con offer_always tampoco entrega stock', async () => {
    const semantic = makeSemantic();
    semantic.search.mockResolvedValue([{ id: 20, score: 0.7 }]);
    const runner = makeRunner(jest.fn().mockResolvedValue([j2Row]), makeCart(), semantic);
    const result = await runner.execute(
      { name: 'find_products_for_need', args: { need: 'contenedor' } },
      { ...context, stockPolicy: 'offer_always' },
    );
    const families = (result.response as { families: Array<{ presentations: unknown[] }> })
      .families;
    expect(families[0].presentations[0]).not.toHaveProperty('stock');
  });

  it('search_products también busca por los sinónimos de la ficha', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await makeRunner(query).execute(
      { name: 'search_products', args: { query: 'portacomida' } },
      context,
    );
    expect(query.mock.calls[0][0]).toMatch(
      /product_assistant_profiles pap[\s\S]*pap\.aliases::text/,
    );
  });

  it('search_products incluye la ficha; una ficha vacía no se manda', async () => {
    const emptyProfile = {
      ...j2Row,
      family_profile: { description: '', uses: [], attributes: [], related: [] },
    };
    const runner = makeRunner(
      jest
        .fn()
        .mockResolvedValue([
          j2Row,
          { ...emptyProfile, id: '30', family_id: '30', family_name: 'OTRO' },
        ]),
    );
    const result = await runner.execute(
      { name: 'search_products', args: { query: 'contenedor' } },
      context,
    );
    const families = (result.response as { families: Array<Record<string, unknown>> }).families;
    expect(families[0]).toHaveProperty('profile');
    expect(families[1]).not.toHaveProperty('profile');
  });
});
