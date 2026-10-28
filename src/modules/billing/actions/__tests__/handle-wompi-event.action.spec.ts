import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { resolveBillingConfig } from '@/config/billing.config';

import type { WompiEvent } from '../../wompi/wompi.types';
import { HandleWompiEventAction } from '../handle-wompi-event.action';

const SECRET = 'test_events_SECRET';

function signedEvent(overrides: Partial<WompiEvent> = {}): WompiEvent {
  const base: WompiEvent = {
    event: 'transaction.updated',
    data: { transaction: { id: 'T-1', status: 'APPROVED', amount_in_cents: 5_000_000 } },
    environment: 'test',
    timestamp: 1700000000,
    ...overrides,
  };
  const checksum = createHash('sha256')
    .update(`T-1APPROVED50000001700000000${SECRET}`)
    .digest('hex');
  return {
    ...base,
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum,
    },
  };
}

function build(env: Record<string, string> = {}): {
  action: HandleWompiEventAction;
  apply: { execute: jest.Mock };
  alerts: { notify: jest.Mock };
} {
  const config = resolveBillingConfig({
    WOMPI_PRIVATE_KEY: 'prv_test_K',
    WOMPI_EVENTS_SECRET: SECRET,
    ...env,
  });
  const wompi = {
    config,
    assertConfigured: jest.fn(),
  };
  const apply = { execute: jest.fn().mockResolvedValue({ payment: {}, outcome: 'approve' }) };
  const alerts = { notify: jest.fn().mockResolvedValue(undefined) };
  const action = new HandleWompiEventAction(wompi as never, apply as never, alerts as never);
  return { action, apply, alerts };
}

describe('HandleWompiEventAction', () => {
  it('evento firmado → verifica la transacción contra Wompi y la aplica', async () => {
    const { action, apply } = build();
    await expect(action.execute(signedEvent())).resolves.toEqual({
      received: true,
      outcome: 'approve',
    });
    expect(apply.execute).toHaveBeenCalledWith('T-1', 'webhook');
  });

  it('firma inválida → 401, alerta al operador y NO aplica nada', async () => {
    const { action, apply, alerts } = build();
    const forged = signedEvent();
    forged.signature = { ...forged.signature, checksum: 'f'.repeat(64) };

    await expect(action.execute(forged)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(apply.execute).not.toHaveBeenCalled();
    expect(alerts.notify).toHaveBeenCalledTimes(1);
  });

  it('header de checksum que no coincide → 401', async () => {
    const { action, apply } = build();
    await expect(action.execute(signedEvent(), 'a'.repeat(64))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(apply.execute).not.toHaveBeenCalled();
  });

  it('evento de producción en un servidor sandbox → se ignora', async () => {
    const { action, apply } = build();
    const result = await action.execute(signedEvent({ environment: 'prod' }));
    expect(result.outcome).toBe('ignored');
    expect(apply.execute).not.toHaveBeenCalled();
  });

  it('otros eventos (p. ej. nequi_token.updated) → se ignoran con 200', async () => {
    const { action, apply } = build();
    const result = await action.execute(signedEvent({ event: 'nequi_token.updated' }));
    expect(result.outcome).toBe('ignored');
    expect(apply.execute).not.toHaveBeenCalled();
  });

  it('si aplicar falla, el error sube (→ 500 → Wompi reintenta)', async () => {
    const { action, apply } = build();
    apply.execute.mockRejectedValue(new Error('BD caída'));
    await expect(action.execute(signedEvent())).rejects.toThrow('BD caída');
  });
});
