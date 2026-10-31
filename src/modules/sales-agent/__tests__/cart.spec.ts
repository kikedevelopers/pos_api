import Big from 'big.js';

import {
  CART_TTL_MS,
  MAX_CART_QUANTITY,
  cartTotal,
  cartView,
  describeCartForPrompt,
  emptyCart,
  isCartExpired,
  mergeOrderDetails,
  missingForCheckout,
  orderReference,
  readCartQuantity,
  readAmountRequested,
  isDeliveryModeOffered,
  resolveDeliveryMode,
  setCartItem,
  type SellerCart,
} from '../internal/cart';

const arroz = { product_id: 5, name: 'ARROZ X LIBRA', unit_price: new Big('3000') };
const aceite = { product_id: 9, name: 'ACEITE 1L', unit_price: new Big('12000.499') };

const withItems = (): SellerCart =>
  setCartItem(setCartItem(emptyCart(), arroz, new Big(2)), aceite, new Big(1));

describe('readCartQuantity', () => {
  it('acepta unidades enteras (también "2.0") y 0', () => {
    expect(readCartQuantity(2)?.toString()).toBe('2');
    expect(readCartQuantity('3')?.toString()).toBe('3');
    expect(readCartQuantity('2.0')?.toString()).toBe('2');
    expect(readCartQuantity(0)?.toString()).toBe('0');
  });

  it('RECHAZA fracciones: "media libra" no es 0.5 de una presentación', () => {
    for (const raw of [0.5, '0.5', '1.5', '0.2500', 2.25]) {
      expect(readCartQuantity(raw)).toBeNull();
    }
  });

  it('rechaza negativos, texto, vacío, notación científica y montos enormes', () => {
    for (const raw of [-1, '-2', 'dos', '', null, undefined, '1.23456', '1e3', {}]) {
      expect(readCartQuantity(raw)).toBeNull();
    }
    expect(readCartQuantity(MAX_CART_QUANTITY.plus(1).toString())).toBeNull();
    expect(readCartQuantity(MAX_CART_QUANTITY.toString())).not.toBeNull();
  });
});

describe('setCartItem', () => {
  it('agrega líneas con precio y total exactos (2 decimales)', () => {
    const cart = withItems();
    expect(cart.items).toEqual([
      {
        product_id: 5,
        name: 'ARROZ X LIBRA',
        quantity: '2.0000',
        unit_price: '3000.00',
        total: '6000.00',
      },
      {
        product_id: 9,
        name: 'ACEITE 1L',
        quantity: '1.0000',
        unit_price: '12000.50',
        total: '12000.50',
      },
    ]);
    expect(cartTotal(cart).toFixed(2)).toBe('18000.50');
  });

  it('repetir el producto CORRIGE la cantidad (no la suma) y conserva el orden', () => {
    const cart = setCartItem(withItems(), arroz, new Big(5));
    expect(cart.items.map((item) => [item.product_id, item.quantity])).toEqual([
      [5, '5.0000'],
      [9, '1.0000'],
    ]);
  });

  it('cantidad 0 quita la línea', () => {
    const cart = setCartItem(withItems(), arroz, new Big(0));
    expect(cart.items.map((item) => item.product_id)).toEqual([9]);
  });

  it('no muta el carrito original', () => {
    const original = withItems();
    setCartItem(original, arroz, new Big(0));
    expect(original.items).toHaveLength(2);
  });
});

describe('mergeOrderDetails', () => {
  it('recorta, guarda solo lo válido y no borra lo que ya había', () => {
    let cart = mergeOrderDetails(emptyCart(), {
      customer_name: '  Ana  ',
      delivery_mode: 'DOMICILIO',
    });
    cart = mergeOrderDetails(cart, { delivery_address: 'Cra 1 #2-3', customer_name: '   ' });
    expect(cart.details).toEqual({
      customer_name: 'Ana',
      delivery_mode: 'domicilio',
      delivery_address: 'Cra 1 #2-3',
    });
  });

  it('ignora modos de entrega desconocidos, tipos no texto y claves ajenas', () => {
    const cart = mergeOrderDetails(emptyCart(), {
      delivery_mode: 'dron',
      customer_phone: 3001234567,
      hack: 'x',
    });
    expect(cart.details).toEqual({});
  });

  it('acota el largo de cada dato', () => {
    const cart = mergeOrderDetails(emptyCart(), { notes: 'x'.repeat(1000) });
    expect(cart.details.notes).toHaveLength(250);
  });
});

describe('readAmountRequested', () => {
  it('lee el valor por unidad en pesos, con o sin signos', () => {
    expect(readAmountRequested(2000)?.toString()).toBe('2000');
    expect(readAmountRequested('2.000')?.toString()).toBe('2000');
    expect(readAmountRequested('$ 1.000')?.toString()).toBe('1000');
  });

  it('rechaza 0, negativos, decimales y texto', () => {
    for (const raw of [0, -2000, '20.5', 'dos mil', '', null, undefined, {}]) {
      expect(readAmountRequested(raw)).toBeNull();
    }
  });
});

describe('missingForCheckout', () => {
  it('carrito vacío y sin datos: falta todo', () => {
    expect(missingForCheckout(emptyCart(), { pickupAvailable: true })).toEqual([
      'productos',
      'si es a domicilio o lo recoge',
      'nombre de quien recibe',
    ]);
  });

  it('sin punto físico siempre es domicilio: pide la dirección, no el modo', () => {
    expect(missingForCheckout(withItems(), { pickupAvailable: false })).toEqual([
      'dirección de entrega',
      'nombre de quien recibe',
    ]);
  });

  it('un carrito con cantidades fraccionadas (de antes de la regla) NO se puede cerrar', () => {
    const legacy = mergeOrderDetails(withItems(), {
      delivery_mode: 'recoger',
      customer_name: 'Ana',
    });
    legacy.items[0] = { ...legacy.items[0], quantity: '0.5000' };
    expect(missingForCheckout(legacy, { pickupAvailable: true })).toEqual([
      'corregir cantidades fraccionadas (ARROZ X LIBRA): van en unidades enteras de la presentación',
    ]);
  });

  it('recoger no pide dirección', () => {
    const cart = mergeOrderDetails(withItems(), { delivery_mode: 'recoger', customer_name: 'Ana' });
    expect(missingForCheckout(cart, { pickupAvailable: true })).toEqual([]);
  });

  it('domicilio con dirección y nombre: listo para cerrar', () => {
    const cart = mergeOrderDetails(withItems(), {
      delivery_mode: 'domicilio',
      delivery_address: 'Cra 1',
      customer_name: 'Ana',
    });
    expect(missingForCheckout(cart, { pickupAvailable: true })).toEqual([]);
  });
});

describe('vencimiento y referencia', () => {
  it('un carrito vence a las 24 h sin cambios', () => {
    const cart = emptyCart(new Date('2026-10-30T10:00:00Z'));
    const at = Date.parse('2026-10-30T10:00:00Z');
    expect(isCartExpired(cart, at + CART_TTL_MS)).toBe(false);
    expect(isCartExpired(cart, at + CART_TTL_MS + 1)).toBe(true);
    expect(isCartExpired({ ...cart, updated_at: 'basura' })).toBe(true);
  });

  it('cada carrito nuevo trae un identificador distinto', () => {
    expect(emptyCart().operation_id).not.toBe(emptyCart().operation_id);
  });

  it('la referencia es corta y legible', () => {
    expect(orderReference('4f2a9c1b-0000-4000-8000-000000000000')).toBe('P-4F2A9C1B');
  });
});

describe('cartView y describeCartForPrompt', () => {
  it('la vista del modelo trae líneas, total, datos y lo que falta', () => {
    expect(cartView(withItems(), { pickupAvailable: false })).toEqual({
      items: [
        { product_id: 5, name: 'ARROZ X LIBRA', quantity: 2, unit_price: 3000, total: 6000 },
        { product_id: 9, name: 'ACEITE 1L', quantity: 1, unit_price: 12000.5, total: 12000.5 },
      ],
      total: 18000.5,
      details: {},
      missing_to_close: ['dirección de entrega', 'nombre de quien recibe'],
    });
  });

  it('carrito vacío: etapa de entender y proponer', () => {
    expect(describeCartForPrompt(null, { pickupAvailable: false })).toMatch(
      /carrito está vacío. Etapa: ENTENDER la necesidad y PROPONER/,
    );
  });

  it('tras un pedido cerrado, avisa que uno nuevo es OTRO pedido', () => {
    const cart: SellerCart = {
      ...emptyCart(),
      last_order: { reference: 'P-1', total: '6000.00', placed_at: '2026-10-30T10:00:00Z' },
    };
    expect(describeCartForPrompt(cart, { pickupAvailable: false })).toMatch(
      /Ya le tomaste un pedido en esta conversación \(P-1, \$ 6\.000\)/,
    );
  });

  it('armando: lista líneas con id, total y lo que falta', () => {
    const block = describeCartForPrompt(withItems(), { pickupAvailable: false });
    expect(block).toContain('- 2 × ARROZ X LIBRA (id 5) a $ 3.000 = $ 6.000');
    expect(block).toContain('Total: $ 18.001');
    expect(block).toMatch(/ARMANDO EL PEDIDO. Falta: dirección de entrega, nombre de quien recibe/);
  });

  it('listo: pide resumir y el "sí"', () => {
    const cart = mergeOrderDetails(withItems(), {
      delivery_address: 'Cra 1',
      customer_name: 'Ana',
    });
    const block = describeCartForPrompt(cart, { pickupAvailable: false });
    expect(block).toMatch(/LISTO PARA CERRAR/);
    expect(block).toContain('Recibe: Ana');
    expect(block).toContain('Dirección: Cra 1');
  });
});

describe('entregas que ofrece el negocio', () => {
  const pickupOnly = { pickupAvailable: true, deliveryAvailable: false };
  const deliveryOnly = { pickupAvailable: false, deliveryAvailable: true };
  const both = { pickupAvailable: true, deliveryAvailable: true };

  it('resolveDeliveryMode: con una sola opción es esa; con las dos, la del cliente', () => {
    expect(resolveDeliveryMode({ delivery_mode: 'domicilio' }, pickupOnly)).toBe('recoger');
    expect(resolveDeliveryMode({ delivery_mode: 'recoger' }, deliveryOnly)).toBe('domicilio');
    expect(resolveDeliveryMode({ delivery_mode: 'recoger' }, both)).toBe('recoger');
    expect(resolveDeliveryMode({}, both)).toBeUndefined();
    // Sin `deliveryAvailable` (clientes viejos) = sí hace domicilios.
    expect(resolveDeliveryMode({}, { pickupAvailable: false })).toBe('domicilio');
  });

  it('isDeliveryModeOffered', () => {
    expect(isDeliveryModeOffered('domicilio', pickupOnly)).toBe(false);
    expect(isDeliveryModeOffered('recoger', pickupOnly)).toBe(true);
    expect(isDeliveryModeOffered('recoger', deliveryOnly)).toBe(false);
    expect(isDeliveryModeOffered('domicilio', { pickupAvailable: true })).toBe(true);
  });

  it('solo recoger: NUNCA falta la dirección (aunque no la haya)', () => {
    const cart = mergeOrderDetails(withItems(), { customer_name: 'Ana' });
    expect(missingForCheckout(cart, pickupOnly)).toEqual([]);
  });

  it('solo domicilio: falta la dirección', () => {
    const cart = mergeOrderDetails(withItems(), { customer_name: 'Ana' });
    expect(missingForCheckout(cart, deliveryOnly)).toEqual(['dirección de entrega']);
  });
});
