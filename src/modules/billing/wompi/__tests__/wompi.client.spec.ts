import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { resolveBillingConfig } from '@/config/billing.config';

import { WompiApiError, WompiClient } from '../wompi.client';

const configured = resolveBillingConfig({
  WOMPI_PRIVATE_KEY: 'prv_test_KEY',
  WOMPI_EVENTS_SECRET: 'test_events_SECRET',
});

function build(config = configured): WompiClient {
  return new WompiClient({ getOrThrow: () => config } as unknown as ConfigService);
}

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  global.fetch = fn;
  return fn;
}

const ORIGINAL_FETCH = global.fetch;
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('WompiClient', () => {
  it('crea un link de UN SOLO USO, con monto fijo y la llave privada', async () => {
    const fetchMock = mockFetch(201, { data: { id: 'LINK1' } });
    const link = await build().createPaymentLink({
      name: 'PlacePOS · Plan Anual',
      description: 'd',
      amount_in_cents: 40_000_000,
      currency: 'COP',
      redirect_url: 'http://x.test/panel/pago?ref=r',
      expires_at: new Date('2026-10-29T00:00:00.000Z'),
      sku: 'a'.repeat(50),
    });

    expect(link.id).toBe('LINK1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.wompi.co/v1/payment_links');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer prv_test_KEY');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      single_use: true,
      collect_shipping: false,
      amount_in_cents: 40_000_000,
      currency: 'COP',
      expires_at: '2026-10-29T00:00:00.000Z',
    });
    expect(body.sku).toHaveLength(36);
  });

  it('consulta una transacción por id', async () => {
    const fetchMock = mockFetch(200, {
      data: { id: 'T-1', status: 'APPROVED', amount_in_cents: 5_000_000, currency: 'COP' },
    });
    const tx = await build().getTransaction('T-1');
    expect(tx.status).toBe('APPROVED');
    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.wompi.co/v1/transactions/T-1');
  });

  it('rechaza ids de transacción con caracteres raros sin llamar a Wompi', async () => {
    const fetchMock = mockFetch(200, {});
    await expect(build().getTransaction('../payment_links')).rejects.toBeInstanceOf(WompiApiError);
    await expect(build().getTransaction('')).rejects.toBeInstanceOf(WompiApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un error HTTP de Wompi se convierte en WompiApiError con el status', async () => {
    mockFetch(422, { error: { type: 'INPUT_VALIDATION_ERROR', messages: { x: ['y'] } } });
    await expect(build().getTransaction('T-1')).rejects.toMatchObject({ status: 422 });
  });

  it('una caída de red es WompiApiError con status 0', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(build().getTransaction('T-1')).rejects.toMatchObject({ status: 0 });
  });

  it('una transacción incompleta no se acepta', async () => {
    mockFetch(200, { data: { id: 'T-1', status: 'APPROVED' } });
    await expect(build().getTransaction('T-1')).rejects.toBeInstanceOf(WompiApiError);
  });

  it('un link sin id no se acepta', async () => {
    mockFetch(201, { data: {} });
    await expect(
      build().createPaymentLink({
        name: 'n',
        description: 'd',
        amount_in_cents: 1,
        currency: 'COP',
        redirect_url: 'r',
        expires_at: new Date(),
        sku: 's',
      }),
    ).rejects.toBeInstanceOf(WompiApiError);
  });

  it('sin llaves válidas: 503 y no llama a Wompi', async () => {
    const fetchMock = mockFetch(200, {});
    const client = build(resolveBillingConfig({}));
    await expect(client.getTransaction('T-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL del checkout del link', () => {
    expect(build().checkoutUrl('ab12')).toBe('https://checkout.wompi.co/l/ab12');
  });
});
