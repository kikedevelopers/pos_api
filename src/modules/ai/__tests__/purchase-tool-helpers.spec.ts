import Big from 'big.js';

import { isExplicitConfirmation } from '../internal/expense-tool-helpers';
import { checkPendingConfirmation, wrongOperationResult } from '../internal/pending-confirmation';
import {
  classifyDocumentMatch,
  computePurchaseLine,
  computePurchaseTotals,
  costDeviationWarning,
  documentDigits,
  documentTotalWarning,
  findByExactName,
  MAX_DOCUMENT_CANDIDATES,
  MAX_DOCUMENT_ITEMS,
  queriesOf,
  readDocumentItemsArg,
  readIvaRateArg,
  readPurchaseLinesArg,
  resolveSupplier,
  sameDocument,
  type SupplierRow,
} from '../internal/purchase-tool-helpers';
import { matchLine, type MatchableProduct } from '../internal/sale-product-matching';

const product = (
  id: number,
  name: string,
  extra: Partial<MatchableProduct> = {},
): MatchableProduct => ({
  id,
  name,
  sku_code: null,
  bar_code: null,
  packaging_name: null,
  ...extra,
});

describe('readDocumentItemsArg', () => {
  it('lee descripción, código y alternativas, numerando por posición', () => {
    const result = readDocumentItemsArg({
      items: [
        { description: '  ACE  GIRAS 1LT ', code: '7701', alternatives: ['aceite de girasol', 3] },
        { code: 'REF-9' },
      ],
    });
    expect(result).toEqual({
      status: 'ok',
      items: [
        {
          position: 1,
          description: 'ACE GIRAS 1LT',
          code: '7701',
          alternatives: ['aceite de girasol'],
        },
        { position: 2, description: 'REF-9', code: 'REF-9', alternatives: [] },
      ],
    });
  });

  it('missing si no hay ítems; inválido si no es lista, sobra o falta descripción', () => {
    expect(readDocumentItemsArg({})).toEqual({ status: 'missing' });
    expect(readDocumentItemsArg({ items: [] })).toEqual({ status: 'missing' });
    expect(readDocumentItemsArg({ items: 'arroz' })).toMatchObject({ status: 'invalid' });
    expect(
      readDocumentItemsArg({
        items: Array.from({ length: MAX_DOCUMENT_ITEMS + 1 }, () => ({ description: 'x' })),
      }),
    ).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/máximo 60/) });
    expect(readDocumentItemsArg({ items: [{ description: '  ' }] })).toMatchObject({
      status: 'invalid',
      reason: 'Al ítem 1 le falta la descripción.',
    });
    expect(readDocumentItemsArg({ items: [null] })).toMatchObject({ status: 'invalid' });
  });

  it('queriesOf prueba descripción, alternativas y código', () => {
    expect(queriesOf({ position: 1, description: 'a', code: 'c', alternatives: ['b'] })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('readPurchaseLinesArg', () => {
  const line = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    description: 'ARROZ X 25 KG',
    quantity: 2,
    unit_cost: 95000,
    ...over,
  });

  it('lee cantidad, costo e IVA como Big; producto confirmado y skip', () => {
    const result = readPurchaseLinesArg({
      lines: [
        line({ iva_rate: 19, product: 'ARROZ DIANA BULTO' }),
        line({ skip: true, quantity: undefined }),
      ],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.lines[0].quantity.toString()).toBe('2');
    expect(result.lines[0].unit_cost.toString()).toBe('95000');
    expect(result.lines[0].iva_rate.toString()).toBe('19');
    expect(result.lines[0].product).toBe('ARROZ DIANA BULTO');
    expect(result.lines[1].skip).toBe(true);
  });

  it('un ítem excluido (skip) no exige cantidad ni costo', () => {
    expect(readPurchaseLinesArg({ lines: [{ description: 'x', skip: true }] }).status).toBe('ok');
  });

  it.each([
    [{ quantity: undefined }, /Falta la cantidad del ítem 1/],
    [{ quantity: 0 }, /mayor a cero/],
    [{ quantity: '1.500' }, /número/],
    [{ unit_cost: undefined }, /Falta el costo unitario/],
    [{ unit_cost: '95.000' }, /sin separadores/],
    [{ unit_cost: 0 }, /mayor a cero/],
    [{ unit_cost: 10.123 }, /2 decimales/],
    [{ iva_rate: 120 }, /entre 0 y 100/],
    [{ iva_rate: '19' }, /porcentaje numérico/],
  ])('rechaza %p', (over, reason) => {
    expect(readPurchaseLinesArg({ lines: [line(over)] })).toMatchObject({
      status: 'invalid',
      reason: expect.stringMatching(reason),
    });
  });

  it('readIvaRateArg: ausente = 0', () => {
    expect((readIvaRateArg(undefined) as Big).toString()).toBe('0');
    expect((readIvaRateArg(5) as Big).toString()).toBe('5');
    expect(readIvaRateArg(-1)).toEqual({ invalid: 'El IVA debe estar entre 0 y 100.' });
  });
});

describe('classifyDocumentMatch (fail-closed)', () => {
  const pool = [
    product(1, 'ACEITE GIRASOL X LITRO', { bar_code: '7701' }),
    product(2, 'ACEITE OLIVA X LITRO'),
    product(3, 'ARROZ DIANA X LIBRA'),
    product(4, 'ARROZ DIANA X KILO'),
  ];

  it('código exacto → encontrado', () => {
    expect(classifyDocumentMatch(matchLine(['7701'], pool, null))).toEqual({
      status: 'found',
      product: pool[0],
      via: 'code',
    });
  });

  it('nombre que no deja duda → encontrado', () => {
    const queries = ['aceite girasol x litro'];
    expect(classifyDocumentMatch(matchLine(queries, pool, null), queries)).toMatchObject({
      status: 'found',
      product: { id: 1 },
    });
  });

  it('palabras de más en el inventario → se pregunta (más estricto que un pedido)', () => {
    const panela = [product(9, 'PANELA REDONDA X 12')];
    const queries = ['PANELA REDONDA'];
    // El motor de pedidos la resolvería sola…
    expect(matchLine(queries, panela, null).status).toBe('resolved');
    // …pero en una factura es solo una posible coincidencia.
    expect(classifyDocumentMatch(matchLine(queries, panela, null), queries)).toEqual({
      status: 'possible_match',
      candidates: [panela[0]],
    });
  });

  it('sin las formas de nombrarlo, un "resuelto por nombre" nunca se da por encontrado', () => {
    expect(classifyDocumentMatch(matchLine(['aceite girasol x litro'], pool, null)).status).toBe(
      'possible_match',
    );
  });

  it('nombre ambiguo → posible coincidencia (se pregunta, nunca se elige)', () => {
    const result = classifyDocumentMatch(matchLine(['aceite por litro'], pool, null));
    expect(result.status).toBe('possible_match');
  });

  it('otro tamaño → posible coincidencia con los tamaños que existen', () => {
    const result = classifyDocumentMatch(matchLine(['arroz diana por arroba'], pool, null));
    expect(result).toMatchObject({ status: 'possible_match' });
    if (result.status === 'possible_match') {
      expect(result.candidates.map((c) => c.id).sort()).toEqual([3, 4]);
    }
  });

  it('parecido por un error de tipeo → posible coincidencia', () => {
    expect(classifyDocumentMatch(matchLine(['aceite girasl'], pool, null)).status).toBe(
      'possible_match',
    );
  });

  it('nada parecido → no encontrado', () => {
    expect(classifyDocumentMatch(matchLine(['detergente en polvo'], pool, null))).toEqual({
      status: 'not_found',
    });
  });

  it('recorta los candidatos', () => {
    const many = Array.from({ length: 12 }, (_, i) => product(i + 10, `ACEITE MARCA${i} X LITRO`));
    const result = classifyDocumentMatch(matchLine(['aceite por litro'], many, null));
    expect(result.status === 'possible_match' && result.candidates.length).toBe(
      MAX_DOCUMENT_CANDIDATES,
    );
  });
});

describe('findByExactName', () => {
  const pool = [product(1, 'Fécula de Maíz x Libra'), product(2, 'AZUCAR'), product(3, 'azúcar')];
  it('ignora tildes, mayúsculas y signos', () => {
    expect(findByExactName(pool, 'FECULA DE MAIZ X LIBRA')).toBe(pool[0]);
  });
  it('dos con el mismo nombre → ambiguo; ninguno → null', () => {
    expect(findByExactName(pool, 'azucar')).toBe('ambiguous');
    expect(findByExactName(pool, 'sal')).toBeNull();
  });
});

describe('proveedor', () => {
  const suppliers: SupplierRow[] = [
    { id: '1', legal_name: 'La Economía', doc_number: '900123456' },
    { id: '2', legal_name: 'Distribuidora Andina S.A.S.', doc_number: '800555444-1' },
    { id: '3', legal_name: 'Andina Lácteos', doc_number: null },
    { id: '4', legal_name: 'Pedro Pérez', doc_number: '1020304050' },
  ];

  it('documentDigits / sameDocument toleran el dígito de verificación', () => {
    expect(documentDigits('900.123.456-7')).toBe('9001234567');
    expect(sameDocument('9001234567', '900123456')).toBe(true);
    expect(sameDocument('900123456', '900123457')).toBe(false);
    expect(sameDocument('12345', '12345')).toBe(false);
  });

  it('por NIT (con DV) se resuelve aunque el nombre difiera', () => {
    expect(
      resolveSupplier(
        { name: 'DISTRIBUIDORA LA ECONOMIA S.A.S.', document: 'NIT 900.123.456-7' },
        suppliers,
      ),
    ).toMatchObject({ status: 'ok', supplier: { id: '1' }, via: 'document' });
  });

  it('nombre idéntico sin sufijos societarios ni tildes → resuelto', () => {
    expect(
      resolveSupplier({ name: 'DISTRIBUIDORA ANDINA SAS', document: null }, suppliers),
    ).toMatchObject({
      status: 'ok',
      supplier: { id: '2' },
      via: 'name',
    });
  });

  it('nombre parecido (en cualquier sentido) → se pregunta', () => {
    const result = resolveSupplier({ name: 'Supermercado La Economia', document: null }, suppliers);
    expect(result).toMatchObject({ status: 'possible_match', candidates: [{ id: '1' }] });
    const andina = resolveSupplier({ name: 'Andina', document: null }, suppliers);
    expect(andina.status).toBe('possible_match');
  });

  it('desconocido → no encontrado; vacío → no encontrado', () => {
    expect(resolveSupplier({ name: 'Colanta', document: null }, suppliers)).toEqual({
      status: 'not_found',
    });
    expect(resolveSupplier({ name: 'S.A.S.', document: null }, suppliers)).toEqual({
      status: 'not_found',
    });
  });

  it('un NIT que no existe cae a la búsqueda por nombre', () => {
    expect(
      resolveSupplier({ name: 'Pedro Perez', document: '111222333' }, suppliers),
    ).toMatchObject({ status: 'ok', supplier: { id: '4' } });
  });
});

describe('cálculo (misma aritmética que CreatePurchaseAction)', () => {
  it('caja x24: unidades mínimas y costo unitario derivados del empaque', () => {
    expect(
      computePurchaseLine({
        quantity: new Big(10),
        unit_cost: new Big(36000),
        iva_rate: new Big(19),
        packaging_value: new Big(24),
      }),
    ).toEqual({
      packaging_qty: '10',
      packaging_price: '36000',
      unit_qty: '240',
      unit_price: '1500',
      iva_rate: '19',
      subtotal: '360000',
      iva_amount: '68400',
      total: '428400',
    });
  });

  it('sin empaque (o empaque 0) cuenta como 1 unidad', () => {
    const line = computePurchaseLine({
      quantity: new Big('2.5'),
      unit_cost: new Big(1000),
      iva_rate: new Big(0),
      packaging_value: new Big(0),
    });
    expect(line).toMatchObject({ unit_qty: '2.5', unit_price: '1000', total: '2500' });
  });

  it('costo unitario periódico se redondea a 4 decimales', () => {
    const line = computePurchaseLine({
      quantity: new Big(1),
      unit_cost: new Big(10000),
      iva_rate: new Big(0),
      packaging_value: new Big(3),
    });
    expect(line.unit_price).toBe('3333.3333');
  });

  it('totales sin redondeo intermedio', () => {
    expect(
      computePurchaseTotals([
        { quantity: new Big(3), unit_cost: new Big('0.33'), iva_rate: new Big(19) },
        { quantity: new Big(1), unit_cost: new Big(100), iva_rate: new Big(5) },
      ]),
    ).toEqual({ subtotal: '100.99', iva_total: '5.19', total: '106.18' });
  });
});

describe('advertencias', () => {
  it('costo muy distinto al de la última compra', () => {
    expect(costDeviationWarning('ACEITE', new Big(36000), new Big(1500))).toMatch(
      /ACEITE.*\$ 36\.000.*\$ 1\.500/,
    );
    expect(costDeviationWarning('ACEITE', new Big(36000), new Big(34000))).toBeNull();
    expect(costDeviationWarning('ACEITE', new Big(36000), null)).toBeNull();
    expect(costDeviationWarning('ACEITE', new Big(36000), new Big(0))).toBeNull();
  });

  it('total de la factura que no cuadra (> 1 %)', () => {
    expect(documentTotalWarning(new Big(428400), new Big(500000), false)).toMatch(
      /\$ 428\.400.*\$ 500\.000/,
    );
    expect(documentTotalWarning(new Big(428400), new Big(428500), false)).toBeNull();
    expect(documentTotalWarning(new Big(428400), null, false)).toBeNull();
    // Con excluidos el total calculado por fuerza es menor: no se compara.
    expect(documentTotalWarning(new Big(100), new Big(500000), true)).toBeNull();
  });
});

describe('confirmación de compras', () => {
  it.each(['sí', 'si, créala', 'ok ingrésala', 'sí, la compra', 'dale, regístrala por favor'])(
    '"%s" confirma una compra',
    (message) => {
      expect(isExplicitConfirmation(message, 'purchase')).toBe(true);
    },
  );

  it.each(['sí pero son 12 cajas', 'no', '¿cuál proveedor?', 'archívalo', 'muévelo'])(
    '"%s" NO confirma una compra',
    (message) => {
      expect(isExplicitConfirmation(message, 'purchase')).toBe(false);
    },
  );

  it('con la herramienta equivocada no se toca la compra pendiente', () => {
    expect(wrongOperationResult('CREATE_PURCHASE')).toEqual({
      status: 'wrong_operation',
      message: expect.stringMatching(/una compra a proveedor.*confirm_purchase/),
    });
  });

  it('el guard común aplica a CREATE_PURCHASE (no se confirma en la misma petición)', () => {
    expect(
      checkPendingConfirmation(
        {
          action_type: 'CREATE_PURCHASE',
          request_id: 'r1',
          trigger_message_hash: 'h',
          is_expired: false,
        },
        { request_id: 'r1', current_user_message: 'sí', previous_user_message: 'x' },
      ),
    ).toMatchObject({ status: 'awaiting_user_reply', expire: false });
  });
});
