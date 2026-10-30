import type { DataSource, Repository } from 'typeorm';

import type { SalesBotConversationEntity } from '../entities/sales-bot-conversation.entity';
import { CART_TTL_MS, emptyCart, mergeOrderDetails, type SellerCart } from '../internal/cart';
import { SellerCartService } from '../seller-cart.service';

const key = { companyId: 7, channel: 'whatsapp-web', chatId: '57300@s.whatsapp.net' };
const origin = { channel: 'whatsapp', chatId: '57300@s.whatsapp.net', chatDisplayName: 'Ana' };

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
  const service = new SellerCartService(
    repo as unknown as Repository<SalesBotConversationEntity>,
    { query } as unknown as DataSource,
  );
  return { service, repo, query, products, current: () => row?.cart ?? null };
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
});
