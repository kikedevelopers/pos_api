import type { DataSource, Repository } from 'typeorm';

import type { SalesBotConversationEntity } from '../entities/sales-bot-conversation.entity';
import { CART_TTL_MS, emptyCart, mergeOrderDetails, type SellerCart } from '../internal/cart';
import type { AgentOrderRecord } from '../internal/agent-order';
import type { SalesAgentOrdersService } from '../sales-agent-orders.service';
import { SellerCartService } from '../seller-cart.service';

const key = { companyId: 7, channel: 'whatsapp-web', chatId: '57300@s.whatsapp.net' };
const origin = {
  channel: 'whatsapp',
  chatId: '573001234567@s.whatsapp.net',
  chatDisplayName: 'Ana',
  channelAccount: '573110000000',
};

/** Fila de detalle vendible (lo que devuelve buildSellableDetailsSql). */
const detail = (id: number, name: string, price: string) => ({
  id: String(id),
  name,
  sku_code: null,
  bar_code: null,
  product_type: 'SIMPLE',
  cost: '1000',
  stock: '10',
  parent_id: null,
  parent_stock: null,
  packaging_name: null,
  packaging_value: null,
  prices: [{ id: 1, name: 'Base', sale_price: price }],
});

const makeService = (initialCart: SellerCart | null = null, rowExists = true) => {
  let row: Partial<SalesBotConversationEntity> | null = rowExists
    ? { id: '1', company_id: '7', channel: key.channel, chat_id: key.chatId, cart: initialCart }
    : null;
  const repo = {
    findOne: jest.fn(async () => (row ? { ...row } : null)),
    update: jest.fn(async (_where: unknown, patch: Partial<SalesBotConversationEntity>) => {
      row = { ...row, ...patch };
    }),
    create: jest.fn((partial: Partial<SalesBotConversationEntity>) => ({ ...partial })),
    save: jest.fn(async (entity: Partial<SalesBotConversationEntity>) => {
      row = { id: '2', ...entity };
      return row;
    }),
  };
  /** Productos que "existen" en la BD: id → fila de detalle. */
  const products = new Map<number, ReturnType<typeof detail>>([
    [5, detail(5, 'ARROZ X LIBRA', '3000')],
    [9, detail(9, 'ACEITE 1L', '12000')],
  ]);
  const query = jest.fn(async (_sql: string, params: unknown[]) => {
    const ids = (params[params.length - 1] as string[]).map(Number);
    return ids.map((id) => products.get(id)).filter(Boolean);
  });
  const orders = {
    record: jest.fn(async (_companyId: number, _record: AgentOrderRecord) => ({
      id: '77',
      inserted: true,
    })),
    amendByCustomer: jest.fn(
      async (
        _companyId: number,
        _orderId: string,
        _record: AgentOrderRecord,
      ): Promise<'updated' | 'locked'> => 'updated',
    ),
    cancelByCustomer: jest.fn(
      async (
        _companyId: number,
        _orderId: string,
        _reason: string | null,
      ): Promise<'cancelled' | 'locked'> => 'cancelled',
    ),
    recordCustomerRequest: jest.fn(async () => undefined),
    findOne: jest.fn(
      async (_companyId: number, _id: number): Promise<Record<string, unknown>> => ({}),
    ),
  };
  const service = new SellerCartService(
    repo as unknown as Repository<SalesBotConversationEntity>,
    { query } as unknown as DataSource,
    orders as unknown as SalesAgentOrdersService,
  );
  return { service, repo, query, products, orders, current: () => row?.cart ?? null };
};

describe('SellerCartService.setItem', () => {
  it('agrega con el precio del SERVIDOR (primer nivel), no el del modelo', async () => {
    const h = makeService();
    const result = await h.service.setItem(key, 5, 2);
    expect(result.status).toBe('ok');
    expect(h.current()?.items).toEqual([
      {
        product_id: 5,
        name: 'ARROZ X LIBRA',
        quantity: '2.0000',
        unit_price: '3000.00',
        total: '6000.00',
      },
    ]);
  });

  it('solo actualiza la columna cart (no pisa la memoria de la charla)', async () => {
    const h = makeService();
    await h.service.setItem(key, 5, 1);
    expect(h.repo.update).toHaveBeenCalledWith({ id: '1' }, { cart: expect.any(Object) });
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it('sin fila de conversación, la crea con el carrito', async () => {
    const h = makeService(null, false);
    await h.service.setItem(key, 5, 1);
    expect(h.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: '7',
        channel: key.channel,
        chat_id: key.chatId,
        turns: [],
      }),
    );
  });

  it('cantidad 0 quita la línea sin consultar la BD', async () => {
    const h = makeService();
    await h.service.setItem(key, 5, 2);
    h.query.mockClear();
    await h.service.setItem(key, 5, 0);
    expect(h.current()?.items).toEqual([]);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('cantidad inválida no toca nada', async () => {
    const h = makeService();
    const result = await h.service.setItem(key, 5, -1);
    expect(result.status).toBe('invalid_quantity');
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('producto inexistente, no vendible o de otro negocio → not_found', async () => {
    const h = makeService();
    const result = await h.service.setItem(key, 777, 1);
    expect(result.status).toBe('not_found');
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('producto sin precio de venta → no_price', async () => {
    const h = makeService();
    h.products.set(11, { ...detail(11, 'SIN PRECIO', '0'), prices: [] });
    const result = await h.service.setItem(key, 11, 1);
    expect(result.status).toBe('no_price');
  });

  it('un carrito vencido se descarta y se empieza uno nuevo', async () => {
    const old: SellerCart = {
      ...emptyCart(),
      items: [
        {
          product_id: 9,
          name: 'ACEITE 1L',
          quantity: '1.0000',
          unit_price: '12000.00',
          total: '12000.00',
        },
      ],
      updated_at: new Date(Date.now() - CART_TTL_MS - 1000).toISOString(),
    };
    const h = makeService(old);
    await expect(h.service.get(key)).resolves.toBeNull();
    await h.service.setItem(key, 5, 1);
    expect(h.current()?.items.map((item) => item.product_id)).toEqual([5]);
  });
});

describe('SellerCartService.setItem · precisión del pedido', () => {
  it('fracción (0.5 para "media libra"): NO toca el pedido y explica la regla', async () => {
    const h = makeService();
    const result = await h.service.setItem(key, 5, 0.5);
    expect(result.status).toBe('invalid_quantity');
    expect(result.status !== 'ok' && result.message).toMatch(/UNIDADES ENTERAS/);
    expect(result.status !== 'ok' && result.message).toMatch(/media libra = cantidad 1/);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.current()).toBeNull();
  });

  it('sin valor pedido (vacío/null), se comporta como siempre', async () => {
    const h = makeService();
    expect((await h.service.setItem(key, 5, 1, '')).status).toBe('ok');
    expect((await h.service.setItem(key, 9, 1, null)).status).toBe('ok');
  });

  it('valor pedido inválido: NO toca el pedido', async () => {
    const h = makeService();
    const result = await h.service.setItem(key, 5, 1, 'dos mil');
    expect(result.status).toBe('invalid_amount');
    expect(h.current()).toBeNull();
  });
});

describe('SellerCartService.setItem · pedido por valor ("2000 de pimienta")', () => {
  /** La consulta de candidatos devuelve `lineIds`; el detalle, lo que exista. */
  const withLine = (h: ReturnType<typeof makeService>, lineIds: number[]) => {
    (h.query as jest.Mock).mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('LIMIT 40')) {
        return lineIds.map((id) => ({ id: String(id) }));
      }
      const ids = (params[params.length - 1] as string[]).map(Number);
      return ids.map((id) => h.products.get(id)).filter(Boolean);
    });
  };
  const PAQ_1000 = () => detail(48446, 'PIMIENTA NEGRA MOLIDA PAQ. X $1 000', '1000');
  const PAQ_2000 = () => detail(48573, 'PIMIENTA NEGRA MOLIDA PAQ. X $2 000', '2000');
  const GRAMO = () => detail(48596, 'PIMIENTA NEGRA MOLIDA X GRAMO', '83');

  it('elige la presentación de $2.000 (1 unidad) aunque el agente mande la de $1.000', async () => {
    const h = makeService();
    h.products.set(48446, PAQ_1000());
    h.products.set(48573, PAQ_2000());
    h.products.set(48596, GRAMO());
    withLine(h, [48446, 48573, 48596]);

    const result = await h.service.setItem(key, 48446, 2, 2000);

    expect(result.status).toBe('ok');
    expect(h.current()?.items).toEqual([
      expect.objectContaining({ product_id: 48573, quantity: '1.0000', total: '2000.00' }),
    ]);
    expect(result.status === 'ok' && result.note).toMatch(
      /1 × PIMIENTA NEGRA MOLIDA PAQ\. X \$2 000/,
    );
    // Busca la línea por el nombre base, no por el nombre completo.
    const [candidateSql, params] = h.query.mock.calls.find(([sql]) =>
      String(sql).includes('LIMIT 40'),
    )!;
    expect(candidateSql).toContain('p.show_in_pos = true');
    expect(params).toEqual(
      expect.arrayContaining(['pimienta negra molida', 'pimienta negra molida %']),
    );
  });

  it('sin la de $2.000, por gramos (24 g = $ 1.992)', async () => {
    const h = makeService();
    h.products.set(48446, PAQ_1000());
    h.products.set(48596, GRAMO());
    withLine(h, [48446, 48596]);

    const result = await h.service.setItem(key, 48446, 1, 2000);

    expect(h.current()?.items).toEqual([
      expect.objectContaining({ product_id: 48596, quantity: '24.0000', total: '1992.00' }),
    ]);
    expect(result.status === 'ok' && result.note).toMatch(/24 gramos .* \$ 1\.992/);
  });

  it('sin $2.000 ni gramo: 2 × $1.000', async () => {
    const h = makeService();
    h.products.set(48446, PAQ_1000());
    withLine(h, [48446]);

    await h.service.setItem(key, 48446, 1, '2.000');

    expect(h.current()?.items).toEqual([
      expect.objectContaining({ product_id: 48446, quantity: '2.0000', total: '2000.00' }),
    ]);
  });

  it('nada cuadra: NO toca el pedido y le dice al agente que pregunte, con las opciones', async () => {
    const h = makeService();
    h.products.set(7, detail(7, 'PIMIENTA NEGRA MOLIDA PAQ. X $1 500', '1500'));
    withLine(h, [7]);

    const result = await h.service.setItem(key, 7, 1, 2000);

    expect(result.status).toBe('amount_unavailable');
    expect(result.status !== 'ok' && result.message).toMatch(/pregúntale cuál prefiere/);
    expect(result.status !== 'ok' && result.message).toMatch(/PAQ\. X \$1 500 \(\$ 1\.500\)/);
    expect(h.current()).toBeNull();
  });

  it('producto inexistente → not_found', async () => {
    const h = makeService();
    withLine(h, []);
    expect((await h.service.setItem(key, 999, 1, 2000)).status).toBe('not_found');
  });
});

describe('SellerCartService.close', () => {
  const ready = async (h: ReturnType<typeof makeService>) => {
    await h.service.setItem(key, 5, 2);
    await h.service.setDetails(key, { customer_name: 'Ana', delivery_address: 'Cra 1 #2-3' });
  };

  it('completo: devuelve el pedido para AVISAR al dueño y vacía el carrito', async () => {
    const h = makeService();
    await ready(h);
    const before = h.current();

    const result = await h.service.close(key, { pickupAvailable: false }, origin);

    expect(result.status).toBe('closed');
    if (result.status !== 'closed') {
      return;
    }
    expect(result.order).toMatchObject({
      reference: expect.stringMatching(/^P-[0-9A-F]{8}$/),
      items: [{ name: 'ARROZ X LIBRA', quantity: 2, unit_price: 3000, line_total: 6000 }],
      total: 6000,
      customer_name: 'Ana',
      delivery: 'Domicilio: Cra 1 #2-3',
      channel: 'whatsapp',
      chat_display_name: 'Ana',
    });
    const after = h.current();
    expect(after?.items).toEqual([]);
    // Conserva los datos de entrega y deja la referencia del pedido cerrado.
    expect(after?.details.customer_name).toBe('Ana');
    expect(after?.last_order?.reference).toBe(result.order.reference);
    // El próximo pedido tendrá otra referencia.
    expect(after?.operation_id).not.toBe(before?.operation_id);
  });

  it('recoger en el negocio queda indicado en la entrega', async () => {
    const h = makeService();
    await h.service.setItem(key, 5, 1);
    await h.service.setDetails(key, { customer_name: 'Ana', delivery_mode: 'recoger' });
    const result = await h.service.close(key, { pickupAvailable: true }, origin);
    expect(result.status === 'closed' && result.order.delivery).toBe('Recoge en el negocio');
  });

  it('con datos faltantes NO cierra y dice qué falta', async () => {
    const h = makeService();
    await h.service.setItem(key, 5, 1);
    const result = await h.service.close(key, { pickupAvailable: false }, origin);
    expect(result).toMatchObject({
      status: 'missing_data',
      missing: ['dirección de entrega', 'nombre de quien recibe'],
    });
    expect(h.current()?.items).toHaveLength(1);
  });

  it('carrito vacío: falta productos (un segundo close no duplica el aviso)', async () => {
    const h = makeService();
    await ready(h);
    await h.service.close(key, { pickupAvailable: false }, origin);
    const again = await h.service.close(key, { pickupAvailable: false }, origin);
    expect(again.status).toBe('missing_data');
    expect(again.status === 'missing_data' && again.missing).toContain('productos');
  });

  it('si un precio cambió, NO cierra: actualiza el carrito para reconfirmar', async () => {
    const h = makeService();
    await ready(h);
    h.products.set(5, detail(5, 'ARROZ X LIBRA', '3500'));

    const result = await h.service.close(key, { pickupAvailable: false }, origin);

    expect(result.status).toBe('price_changed');
    expect(h.current()?.items[0]).toMatchObject({ unit_price: '3500.00', total: '7000.00' });
  });

  it('si un producto dejó de venderse, NO cierra y lo quita del carrito', async () => {
    const h = makeService();
    await ready(h);
    await h.service.setItem(key, 9, 1);
    h.products.delete(9);

    const result = await h.service.close(key, { pickupAvailable: false }, origin);

    expect(result.status).toBe('price_changed');
    expect(h.current()?.items.map((item) => item.product_id)).toEqual([5]);
  });

  it('respeta datos ya guardados (mergeOrderDetails) al cerrar', async () => {
    const cart = mergeOrderDetails(emptyCart(), { customer_name: 'Ana', payment_method: 'Nequi' });
    const h = makeService(cart);
    await h.service.setItem(key, 5, 1);
    await h.service.setDetails(key, { delivery_address: 'Cra 1' });
    const result = await h.service.close(key, { pickupAvailable: false }, origin);
    expect(result.status === 'closed' && result.order.payment_method).toBe('Nequi');
  });

  it('guarda el pedido en la bandeja del informe "Agente" con todos sus datos', async () => {
    const h = makeService();
    await ready(h);
    await h.service.setDetails(key, { customer_phone: '3001234567', payment_method: 'Nequi' });
    const operationId = h.current()?.operation_id;

    const result = await h.service.close(key, { pickupAvailable: false }, origin);

    expect(result.status).toBe('closed');
    expect(h.orders.record).toHaveBeenCalledTimes(1);
    expect(h.orders.record).toHaveBeenCalledWith(7, {
      operation_id: operationId,
      reference: result.status === 'closed' ? result.order.reference : '',
      // El canal de la CONVERSACIÓN (distingue WhatsApp por QR de Cloud API).
      channel: 'whatsapp-web',
      channel_account: '573110000000',
      chat_id: '573001234567@s.whatsapp.net',
      chat_display_name: 'Ana',
      chat_phone: '573001234567',
      customer_name: 'Ana',
      customer_phone: '3001234567',
      delivery_mode: 'domicilio',
      delivery_address: 'Cra 1 #2-3',
      payment_method: 'Nequi',
      notes: null,
      items: [
        {
          product_id: 5,
          name: 'ARROZ X LIBRA',
          quantity: '2.0000',
          unit_price: '3000.00',
          total: '6000.00',
        },
      ],
      items_count: 1,
      total: '6000.00',
    });
  });

  it('si guardar el pedido falla, NO vacía el carrito (el cierre se puede repetir)', async () => {
    const h = makeService();
    await ready(h);
    h.orders.record.mockRejectedValueOnce(new Error('db down'));

    await expect(h.service.close(key, { pickupAvailable: false }, origin)).rejects.toThrow(
      'db down',
    );
    expect(h.current()?.items).toHaveLength(1);
    expect(h.current()?.last_order).toBeUndefined();
  });

  it('con datos faltantes o precio cambiado NO guarda nada en la bandeja', async () => {
    const h = makeService();
    await h.service.setItem(key, 5, 1);
    await h.service.close(key, { pickupAvailable: false }, origin);
    await h.service.setDetails(key, { customer_name: 'Ana', delivery_address: 'Cra 1' });
    h.products.set(5, detail(5, 'ARROZ X LIBRA', '3500'));
    await h.service.close(key, { pickupAvailable: false }, origin);
    expect(h.orders.record).not.toHaveBeenCalled();
  });
});

/** Pedido tal como lo devuelve el informe (lo que importa para reabrirlo). */
const orderView = (patch: Record<string, unknown> = {}) => ({
  id: 77,
  reference: 'P-ABCDEF12',
  status: 'pending',
  ticket: null,
  cancelled_by_customer: false,
  items: [
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
      unit_price: '12000.00',
      total: '12000.00',
    },
  ],
  customer_name: 'Ana',
  customer_phone: null,
  delivery_mode: 'domicilio',
  delivery_address: 'Cra 1',
  payment_method: 'Efectivo',
  notes: null,
  ...patch,
});

describe('SellerCartService · el cliente cambia o cancela su pedido', () => {
  const placed = async (h: ReturnType<typeof makeService>) => {
    await h.service.setItem(key, 5, 2);
    await h.service.setItem(key, 9, 1);
    await h.service.setDetails(key, { customer_name: 'Ana', delivery_address: 'Cra 1' });
    const closed = await h.service.close(key, { pickupAvailable: false }, origin);
    expect(closed.status).toBe('closed');
  };

  it('al cerrar, el carrito recuerda el id del pedido (para poder cambiarlo)', async () => {
    const h = makeService();
    await placed(h);
    expect(h.current()?.last_order).toMatchObject({ order_id: '77' });
  });

  it('modificar: vuelve el MISMO pedido al carrito y, al cerrar, lo ACTUALIZA (no crea otro)', async () => {
    const h = makeService();
    await placed(h);
    h.orders.findOne.mockResolvedValue(orderView());

    const reopened = await h.service.reopenLastOrder(key);
    expect(reopened.status).toBe('reopened');
    expect(h.current()?.amends).toEqual({ order_id: '77', reference: 'P-ABCDEF12' });
    expect(h.current()?.items.map((item) => item.product_id)).toEqual([5, 9]);

    // "Ya no quiero el aceite"
    await h.service.setItem(key, 9, 0);
    h.orders.record.mockClear();
    const result = await h.service.close(key, { pickupAvailable: false }, origin);

    expect(result.status).toBe('closed');
    expect(h.orders.record).not.toHaveBeenCalled();
    expect(h.orders.amendByCustomer).toHaveBeenCalledWith(
      7,
      '77',
      expect.objectContaining({ reference: 'P-ABCDEF12', total: '6000.00', items_count: 1 }),
    );
    if (result.status === 'closed') {
      expect(result.order).toMatchObject({ kind: 'updated', reference: 'P-ABCDEF12', total: 6000 });
    }
    expect(h.current()?.amends).toBeUndefined();
    expect(h.current()?.last_order).toMatchObject({
      reference: 'P-ABCDEF12',
      order_id: '77',
      total: '6000.00',
    });
  });

  it('modificar un pedido ya TOMADO: no lo reabre (locked)', async () => {
    const h = makeService();
    await placed(h);
    h.orders.findOne.mockResolvedValue(orderView({ status: 'taken' }));
    await expect(h.service.reopenLastOrder(key)).resolves.toMatchObject({ status: 'locked' });
    expect(h.current()?.items).toEqual([]);
    expect(h.current()?.amends).toBeUndefined();
  });

  it('modificar un pedido con ticket vivo: locked; con ticket anulado y por tomar: se reabre', async () => {
    const h = makeService();
    await placed(h);
    h.orders.findOne.mockResolvedValue(
      orderView({
        ticket: { id: 1, type: 'ORDER', number: 'PED-1', is_credit: false, is_voided: false },
      }),
    );
    await expect(h.service.reopenLastOrder(key)).resolves.toMatchObject({ status: 'locked' });
    h.orders.findOne.mockResolvedValue(
      orderView({
        ticket: { id: 1, type: 'ORDER', number: 'PED-1', is_credit: false, is_voided: true },
      }),
    );
    await expect(h.service.reopenLastOrder(key)).resolves.toMatchObject({ status: 'reopened' });
  });

  it('si mientras confirmaba una persona lo TOMÓ, el cierre no lo pisa (locked)', async () => {
    const h = makeService();
    await placed(h);
    h.orders.findOne.mockResolvedValue(orderView());
    await h.service.reopenLastOrder(key);
    h.orders.amendByCustomer.mockResolvedValueOnce('locked');
    h.orders.findOne.mockResolvedValue(orderView({ status: 'taken' }));

    const result = await h.service.close(key, { pickupAvailable: false }, origin);

    expect(result.status).toBe('locked');
    expect(h.orders.record).toHaveBeenCalledTimes(1); // solo el cierre original
    expect(h.current()?.items).toEqual([]);
    expect(h.current()?.amends).toBeUndefined();
  });

  it('sin pedido anterior (o carrito viejo sin id): none', async () => {
    const h = makeService();
    await expect(h.service.reopenLastOrder(key)).resolves.toEqual({ status: 'none' });
    await expect(h.service.cancelLastOrder(key, null)).resolves.toEqual({ status: 'none' });
  });

  it('con un pedido NUEVO en curso no reabre el anterior (cart_busy)', async () => {
    const h = makeService();
    await placed(h);
    await h.service.setItem(key, 5, 1);
    await expect(h.service.reopenLastOrder(key)).resolves.toEqual({ status: 'cart_busy' });
  });

  it('cancelar: por tomar → cancelado por el cliente', async () => {
    const h = makeService();
    await placed(h);
    await expect(h.service.cancelLastOrder(key, 'ya no')).resolves.toMatchObject({
      status: 'cancelled',
      reference: expect.stringMatching(/^P-/),
    });
    expect(h.orders.cancelByCustomer).toHaveBeenCalledWith(7, '77', 'ya no');
  });

  it('cancelar mientras lo modificaba: suelta la modificación', async () => {
    const h = makeService();
    await placed(h);
    h.orders.findOne.mockResolvedValue(orderView());
    await h.service.reopenLastOrder(key);
    await h.service.cancelLastOrder(key, null);
    expect(h.current()?.items).toEqual([]);
    expect(h.current()?.amends).toBeUndefined();
  });

  it('cancelar un pedido ya TOMADO: locked con el pedido', async () => {
    const h = makeService();
    await placed(h);
    h.orders.cancelByCustomer.mockResolvedValueOnce('locked');
    h.orders.findOne.mockResolvedValue(orderView({ status: 'taken' }));
    await expect(h.service.cancelLastOrder(key, null)).resolves.toMatchObject({
      status: 'locked',
      order: { status: 'taken' },
    });
  });

  it('solicitud sobre el último pedido: la anota y devuelve el pedido', async () => {
    const h = makeService();
    await placed(h);
    h.orders.findOne.mockResolvedValue(orderView({ status: 'taken' }));
    await expect(
      h.service.requestOnLastOrder(key, 'Cambiar: quitar el aceite'),
    ).resolves.toMatchObject({
      status: 'taken',
    });
    expect(h.orders.recordCustomerRequest).toHaveBeenCalledWith(
      7,
      '77',
      'Cambiar: quitar el aceite',
    );
  });
});
