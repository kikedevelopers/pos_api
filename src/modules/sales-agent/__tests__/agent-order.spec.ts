import {
  buildAgentOrderRecord,
  canTransition,
  chatPhoneOf,
  normalizeStatusNote,
} from '../internal/agent-order';
import { emptyCart, mergeOrderDetails, setCartItem, type SellerCart } from '../internal/cart';
import Big from 'big.js';

const cartWith = (details: Record<string, unknown>): SellerCart => {
  let cart = emptyCart(new Date('2026-10-31T15:00:00Z'));
  cart = setCartItem(
    cart,
    { product_id: 5, name: 'CAFÉ LIBRA', unit_price: new Big('18000') },
    new Big('2'),
  );
  cart = setCartItem(
    cart,
    { product_id: 9, name: 'AREPA', unit_price: new Big('1500.5') },
    new Big('3'),
  );
  return mergeOrderDetails(cart, details);
};

const origin = { channel: 'telegram', chatId: '998877', chatDisplayName: 'Ana Pérez' };

describe('chatPhoneOf', () => {
  it('WhatsApp Cloud: el id del chat ES el número', () => {
    expect(chatPhoneOf('whatsapp', '573001234567')).toBe('573001234567');
  });

  it('WhatsApp por QR: toma el número del JID (también con sufijo de dispositivo)', () => {
    expect(chatPhoneOf('whatsapp-web', '573001234567@s.whatsapp.net')).toBe('573001234567');
    expect(chatPhoneOf('whatsapp-web', '573001234567:12@s.whatsapp.net')).toBe('573001234567');
  });

  it('identidad oculta (@lid), grupos y Telegram no traen número', () => {
    expect(chatPhoneOf('whatsapp-web', '1234567890@lid')).toBeNull();
    expect(chatPhoneOf('whatsapp-web', '120363@g.us')).toBeNull();
    expect(chatPhoneOf('telegram', '573001234567')).toBeNull();
  });

  it('ids que no parecen números se descartan', () => {
    expect(chatPhoneOf('whatsapp', 'abc')).toBeNull();
    expect(chatPhoneOf('whatsapp', '123')).toBeNull();
    expect(chatPhoneOf('whatsapp-web', '12@s.whatsapp.net')).toBeNull();
    expect(chatPhoneOf('whatsapp-web', '@s.whatsapp.net')).toBeNull();
  });
});

describe('buildAgentOrderRecord', () => {
  it('congela líneas, total exacto y datos del cliente', () => {
    const cart = cartWith({
      customer_name: '  Ana Pérez ',
      customer_phone: '3001234567',
      delivery_mode: 'domicilio',
      delivery_address: 'Cra 1 #2-3',
      payment_method: 'Transferencia',
      notes: 'Tocar el timbre',
    });

    const record = buildAgentOrderRecord(
      cart,
      { pickupAvailable: true, reference: 'P-ABCDEF12' },
      { ...origin, channelAccount: '@mi_tienda_bot' },
    );

    expect(record).toEqual({
      operation_id: cart.operation_id,
      reference: 'P-ABCDEF12',
      channel: 'telegram',
      channel_account: '@mi_tienda_bot',
      chat_id: '998877',
      chat_display_name: 'Ana Pérez',
      chat_phone: null,
      customer_name: 'Ana Pérez',
      customer_phone: '3001234567',
      delivery_mode: 'domicilio',
      delivery_address: 'Cra 1 #2-3',
      payment_method: 'Transferencia',
      notes: 'Tocar el timbre',
      items: [
        {
          product_id: 5,
          name: 'CAFÉ LIBRA',
          quantity: '2.0000',
          unit_price: '18000.00',
          total: '36000.00',
        },
        {
          product_id: 9,
          name: 'AREPA',
          quantity: '3.0000',
          unit_price: '1500.50',
          total: '4501.50',
        },
      ],
      items_count: 2,
      total: '40501.50',
    });
  });

  it('recoger en el negocio: modo recoger y SIN dirección', () => {
    const record = buildAgentOrderRecord(
      cartWith({ customer_name: 'Ana', delivery_mode: 'recoger', delivery_address: 'Cra 1' }),
      { pickupAvailable: true, reference: 'P-1' },
      origin,
    );
    expect(record.delivery_mode).toBe('recoger');
    expect(record.delivery_address).toBeNull();
  });

  it('sin punto físico el pedido es SIEMPRE a domicilio aunque haya dicho recoger', () => {
    const record = buildAgentOrderRecord(
      cartWith({ customer_name: 'Ana', delivery_mode: 'recoger', delivery_address: 'Cra 1' }),
      { pickupAvailable: false, reference: 'P-1' },
      origin,
    );
    expect(record.delivery_mode).toBe('domicilio');
    expect(record.delivery_address).toBe('Cra 1');
  });

  it('datos ausentes o vacíos quedan en null (sin cuenta de canal tampoco)', () => {
    const record = buildAgentOrderRecord(
      cartWith({ customer_name: 'Ana' }),
      { pickupAvailable: false, reference: 'P-1' },
      { channel: 'whatsapp-web', chatId: '573001234567@s.whatsapp.net', chatDisplayName: '   ' },
    );
    expect(record).toMatchObject({
      channel_account: null,
      chat_display_name: null,
      chat_phone: '573001234567',
      customer_phone: null,
      payment_method: null,
      notes: null,
    });
  });

  it('acota textos largos al tamaño de la columna', () => {
    const record = buildAgentOrderRecord(
      cartWith({ customer_name: 'Ana' }),
      { pickupAvailable: false, reference: 'P-1' },
      { ...origin, chatDisplayName: 'x'.repeat(300), channelAccount: 'y'.repeat(300) },
    );
    expect(record.chat_display_name).toHaveLength(120);
    expect(record.channel_account).toHaveLength(120);
  });
});

describe('canTransition', () => {
  it('por tomar → tomado o descartado', () => {
    expect(canTransition('pending', 'taken')).toBe(true);
    expect(canTransition('pending', 'dismissed')).toBe(true);
  });

  it('tomado / descartado → de nuevo por tomar (deshacer)', () => {
    expect(canTransition('taken', 'pending')).toBe(true);
    expect(canTransition('dismissed', 'pending')).toBe(true);
  });

  it('NO salta directo entre tomado y descartado, ni al mismo estado', () => {
    expect(canTransition('taken', 'dismissed')).toBe(false);
    expect(canTransition('dismissed', 'taken')).toBe(false);
    expect(canTransition('pending', 'pending')).toBe(false);
  });
});

describe('normalizeStatusNote', () => {
  it('recorta, acota a 250 y vacío = null', () => {
    expect(normalizeStatusNote('  sin stock ')).toBe('sin stock');
    expect(normalizeStatusNote('   ')).toBeNull();
    expect(normalizeStatusNote(undefined)).toBeNull();
    expect(normalizeStatusNote(42)).toBeNull();
    expect(normalizeStatusNote('a'.repeat(400))).toHaveLength(250);
  });
});

describe('buildAgentOrderRecord · entregas del negocio', () => {
  it('solo recoger: queda "recoger" sin dirección aunque el cliente haya dicho domicilio', () => {
    const record = buildAgentOrderRecord(
      cartWith({ customer_name: 'Ana', delivery_mode: 'domicilio', delivery_address: 'Cra 1' }),
      { pickupAvailable: true, deliveryAvailable: false, reference: 'P-1' },
      origin,
    );
    expect(record.delivery_mode).toBe('recoger');
    expect(record.delivery_address).toBeNull();
  });
});

describe('buildAgentOrderRecord · número del chat @lid', () => {
  it('usa el número que resolvió el escritorio aunque el chat sea @lid', () => {
    const record = buildAgentOrderRecord(
      cartWith({ customer_name: 'Ana' }),
      { pickupAvailable: false, reference: 'P-1' },
      { channel: 'whatsapp-web', chatId: '16660832456755@lid', chatPhone: '+57 316 138 4577' },
    );
    expect(record.chat_phone).toBe('573161384577');
  });

  it('número inválido: cae al que se pueda leer del chat (o null)', () => {
    expect(
      buildAgentOrderRecord(
        cartWith({ customer_name: 'Ana' }),
        { pickupAvailable: false, reference: 'P-1' },
        { channel: 'whatsapp-web', chatId: '1@lid', chatPhone: '12' },
      ).chat_phone,
    ).toBeNull();
    expect(
      buildAgentOrderRecord(
        cartWith({ customer_name: 'Ana' }),
        { pickupAvailable: false, reference: 'P-1' },
        { channel: 'whatsapp-web', chatId: '573001234567@s.whatsapp.net', chatPhone: '' },
      ).chat_phone,
    ).toBe('573001234567');
  });
});
