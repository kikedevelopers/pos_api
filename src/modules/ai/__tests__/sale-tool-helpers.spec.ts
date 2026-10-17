import Big from 'big.js';

import {
  availableUnits,
  computeSaleTotals,
  marginFromPrices,
  MAX_SALE_LINES,
  mergePricedLines,
  priceLine,
  readPositiveId,
  readQuantityArg,
  readSaleItemsArg,
  visibleLineKey,
  type PricedLine,
  type SellableProduct,
} from '../internal/sale-tool-helpers';

/**
 * Reglas que deciden QUÉ se factura. La matemática debe ser la del POS al
 * centavo (`posLineMath` + `saleSchema`), y nada dudoso se interpreta.
 */

const sellable = (over: Partial<SellableProduct> = {}): SellableProduct => ({
  id: 1,
  name: 'FECULA DE MAIZ X LIBRA',
  product_type: 'SIMPLE',
  cost: new Big('2200'),
  stock: new Big('5000'),
  parent_id: null,
  parent_stock: null,
  packaging_name: 'LIBRA',
  packaging_value: new Big('500'),
  prices: [
    { id: 10, name: 'Base', sale_price: new Big('4500') },
    { id: 11, name: 'Mayorista', sale_price: new Big('4000') },
  ],
  ...over,
});

const price = (over: Partial<Parameters<typeof priceLine>[0]> = {}): ReturnType<typeof priceLine> =>
  priceLine({
    product: sellable(),
    quantity: new Big(2),
    price_level: null,
    manual_price: null,
    note: null,
    minimum_margin: null,
    ...over,
  });

const okLine = (result: ReturnType<typeof priceLine>): PricedLine => {
  if (result.status !== 'ok') {
    throw new Error(`Se esperaba una línea, llegó ${result.status}`);
  }
  return result.line;
};

describe('readQuantityArg', () => {
  it.each([
    [2, '2'],
    [0.5, '0.5'],
    [500, '500'],
    [1.2345, '1.2345'],
    ['3', '3'],
    ['0.25', '0.25'],
  ])('acepta %p', (raw, expected) => {
    const read = readQuantityArg(raw);
    expect(read.status === 'ok' && read.quantity.toString()).toBe(expected);
  });

  it.each([undefined, null, '', '   '])('falta (%p) → missing, nunca 1 por defecto', (raw) => {
    expect(readQuantityArg(raw)).toEqual({ status: 'missing' });
  });

  it.each([
    [0, /mayor a cero/],
    [-1, /mayor a cero/],
    [1.23456, /4 decimales/],
    [2_000_000, /máximo/],
    [Number.NaN, /no es un número/],
    [Number.POSITIVE_INFINITY, /no es un número/],
    ['1.500', /número/], // ¿mil quinientos o uno y medio? no se adivina
    ['1,5', /número/],
    ['dos', /número/],
    [true, /número/],
  ])('rechaza %p', (raw, reason) => {
    const read = readQuantityArg(raw);
    expect(read.status).toBe('invalid');
    expect(read.status === 'invalid' && read.reason).toMatch(reason);
  });
});

describe('readPositiveId', () => {
  it('acepta enteros positivos, con o sin #', () => {
    expect(readPositiveId(48419)).toBe(48419);
    expect(readPositiveId('#48419')).toBe(48419);
    expect(readPositiveId(undefined)).toBeNull();
  });

  it.each([0, -3, 1.5, 'abc', '1 OR 1=1', '99999999999999999999'])('rechaza %p', (raw) => {
    expect(readPositiveId(raw)).toBe('invalid');
  });
});

describe('readSaleItemsArg', () => {
  it('sin items o lista vacía → missing', () => {
    expect(readSaleItemsArg({})).toEqual({ status: 'missing' });
    expect(readSaleItemsArg({ items: [] })).toEqual({ status: 'missing' });
  });

  it('items que no son lista → invalid', () => {
    expect(readSaleItemsArg({ items: 'fecula' }).status).toBe('invalid');
  });

  it(`más de ${MAX_SALE_LINES} líneas → invalid`, () => {
    const items = Array.from({ length: MAX_SALE_LINES + 1 }, () => ({ query: 'x', quantity: 1 }));
    expect(readSaleItemsArg({ items }).status).toBe('invalid');
  });

  it('un product_id basura invalida todo (no se ignora en silencio)', () => {
    const read = readSaleItemsArg({ items: [{ product_id: 'DROP TABLE', quantity: 1 }] });
    expect(read.status).toBe('invalid');
  });

  it('lee cada línea: texto limpio, alternativas acotadas, cantidad y precio', () => {
    const read = readSaleItemsArg({
      items: [
        {
          query: '  Maizena   por libra ',
          alternatives: ['fécula de maíz por libra', 7, '', 'a', 'b', 'c', 'd'],
          quantity: 2,
          price_level: 'Mayorista',
          note: 'bien empacado',
        },
        { product_id: 48420, quantity: 1, unit_price: 2600 },
        { query: 'arroz', unit_price: '50.000' },
      ],
    });
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') {
      return;
    }
    const [first, second, third] = read.items;
    expect(first).toMatchObject({
      position: 1,
      query: 'Maizena por libra',
      alternatives: ['fécula de maíz por libra', 'a', 'b', 'c'],
      product_id: null,
      price_level: 'Mayorista',
      note: 'bien empacado',
    });
    expect(first.unit_price).toEqual({ status: 'missing' });
    expect(second.product_id).toBe(48420);
    expect(second.unit_price.status === 'ok' && second.unit_price.amount.toString()).toBe('2600');
    expect(third.quantity).toEqual({ status: 'missing' });
    // "50.000" como string: punto de miles colombiano → se rechaza, no son 50 pesos.
    expect(third.unit_price.status).toBe('invalid');
  });

  it('entradas que no son objeto no revientan: quedan como línea vacía', () => {
    const read = readSaleItemsArg({ items: [null, 'x'] });
    expect(read.status === 'ok' && read.items.map((item) => item.query)).toEqual([null, null]);
  });
});

describe('priceLine', () => {
  it('sin nivel ni precio manual usa el PRIMER precio (el del POS) con la matemática del POS', () => {
    const line = okLine(price());
    expect(line).toEqual({
      product_id: 1,
      name: 'FECULA DE MAIZ X LIBRA',
      quantity: '2.0000',
      unit_price: '4500.00',
      cost: '2200.00',
      price_mode: 'fixed',
      price_position: 0,
      price_label: 'Base',
      total: '9000.00',
      profit: '4600.00',
      margin: '51.1111',
      note: null,
    });
  });

  it('nivel por nombre (sin tildes ni mayúsculas) y su posición', () => {
    const line = okLine(price({ price_level: 'mayorista' }));
    expect(line).toMatchObject({
      unit_price: '4000.00',
      price_position: 1,
      price_label: 'Mayorista',
    });
  });

  it('nivel inexistente → lista los niveles reales', () => {
    const result = price({ price_level: 'Distribuidor' });
    expect(result.status).toBe('price_level_not_found');
    expect(result.status !== 'ok' && result.price_levels).toEqual([
      { name: 'Base', price: 4500 },
      { name: 'Mayorista', price: 4000 },
    ]);
  });

  it('producto sin precios → no_prices (no factura en 0)', () => {
    expect(price({ product: sellable({ prices: [] }) }).status).toBe('no_prices');
  });

  it('precio manual: modo manual, sin posición', () => {
    const line = okLine(price({ manual_price: new Big('4200') }));
    expect(line).toMatchObject({
      unit_price: '4200.00',
      price_mode: 'manual',
      price_position: null,
      price_label: 'Precio manual',
      total: '8400.00',
    });
  });

  it('precio manual bajo el costo → rechazado (regla del POS)', () => {
    expect(price({ manual_price: new Big('2199.99') }).status).toBe('below_cost');
  });

  it('precio manual igual al costo sí (margen 0) si no hay margen mínimo', () => {
    expect(okLine(price({ manual_price: new Big('2200') })).margin).toBe('0.0000');
  });

  it('precio manual bajo el margen mínimo → rechazado; justo en el mínimo, aceptado', () => {
    // 20% sobre precio: 2200 / 0.8 = 2750.
    expect(price({ manual_price: new Big('2700'), minimum_margin: 20 }).status).toBe(
      'below_min_margin',
    );
    expect(price({ manual_price: new Big('2750'), minimum_margin: 20 }).status).toBe('ok');
  });

  it('el margen mínimo NO aplica a los precios del catálogo (son los configurados)', () => {
    const cheap = sellable({ prices: [{ id: 1, name: 'Base', sale_price: new Big('2300') }] });
    expect(price({ product: cheap, minimum_margin: 50 }).status).toBe('ok');
  });

  it('cantidades a granel: total y ganancia a 2 decimales al final', () => {
    const gramo = sellable({
      cost: new Big('4.40'),
      prices: [{ id: 1, name: 'Base', sale_price: new Big('8') }],
    });
    const line = okLine(price({ product: gramo, quantity: new Big('333.3333') }));
    expect(line.total).toBe('2666.67');
    expect(line.profit).toBe('1200.00');
  });
});

describe('mergePricedLines', () => {
  it('une el mismo producto al mismo precio (como el carrito) y recalcula', () => {
    const a = okLine(price({ quantity: new Big(1) }));
    const b = okLine(price({ quantity: new Big('1.5') }));
    const merged = mergePricedLines([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ quantity: '2.5000', total: '11250.00', profit: '5750.00' });
  });

  it('NO une el mismo producto a precios distintos ni con notas distintas', () => {
    const base = okLine(price());
    const mayorista = okLine(price({ price_level: 'Mayorista' }));
    const con_nota = okLine(price({ note: 'aparte' }));
    expect(mergePricedLines([base, mayorista, con_nota])).toHaveLength(3);
  });

  it('no muta las líneas de entrada', () => {
    const a = okLine(price());
    mergePricedLines([a, okLine(price())]);
    expect(a.quantity).toBe('2.0000');
  });
});

describe('computeSaleTotals (espejo de saleSchema del POS)', () => {
  it('suma con Big: total, costo, ganancia y margen a 2 decimales', () => {
    const lines = [
      okLine(price()),
      okLine(price({ price_level: 'Mayorista', quantity: new Big(1) })),
    ];
    expect(computeSaleTotals(lines)).toEqual({
      total: '13000.00',
      cost: '6600.00',
      profit: '6400.00',
      margin: '49.23',
    });
  });

  it('pedido vacío → todo en cero (sin dividir por cero)', () => {
    expect(computeSaleTotals([])).toEqual({
      total: '0.00',
      cost: '0.00',
      profit: '0.00',
      margin: '0.00',
    });
  });
});

describe('marginFromPrices', () => {
  it('precio 0 → margen 0 (no divide por cero)', () => {
    expect(marginFromPrices(new Big(0), new Big(10)).toString()).toBe('0');
  });
});

describe('availableUnits', () => {
  it('stock en unidad mínima ÷ factor del empaque', () => {
    expect(availableUnits(sellable())?.toString()).toBe('10');
  });

  it('presentación: lee el stock del padre', () => {
    const presentation = sellable({
      parent_id: 5,
      parent_stock: new Big('1000'),
      packaging_value: new Big('250'),
    });
    expect(availableUnits(presentation)?.toString()).toBe('4');
  });

  it('sin empaque: stock crudo; combo: no aplica', () => {
    expect(availableUnits(sellable({ packaging_value: null, stock: new Big(7) }))?.toString()).toBe(
      '7',
    );
    expect(availableUnits(sellable({ product_type: 'COMBO' }))).toBeNull();
  });
});

describe('visibleLineKey', () => {
  it('cambia si cambia algo que el usuario vio (precio, cantidad, nombre)', () => {
    const line = okLine(price());
    expect(visibleLineKey(line)).toBe(visibleLineKey({ ...line, cost: '1.00', profit: '0.00' }));
    expect(visibleLineKey(line)).not.toBe(visibleLineKey({ ...line, unit_price: '4600.00' }));
    expect(visibleLineKey(line)).not.toBe(visibleLineKey({ ...line, quantity: '3.0000' }));
    expect(visibleLineKey(line)).not.toBe(visibleLineKey({ ...line, name: 'OTRO' }));
  });
});
