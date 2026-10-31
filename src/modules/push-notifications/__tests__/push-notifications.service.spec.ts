import type { Repository } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import { PERMISSION_KEYS } from '@/modules/roles/internal/permission-catalog';

import type { PushSubscriptionEntity } from '../entities/push-subscription.entity';
import type { WebPushSender } from '../internal/web-push.sender';
import { PushNotificationsService } from '../push-notifications.service';

const sub = (overrides: Record<string, unknown> = {}) => ({
  id: '1',
  user_id: '11',
  company_id: '20',
  user_type: 'employee',
  account: 'employee',
  endpoint: 'https://push.example/1',
  p256dh: 'p',
  auth: 'a',
  is_owner: false,
  ...overrides,
});

const event = {
  company_id: 20,
  company_name: 'La 28',
  order_id: 10,
  title: 'Nuevo pedido del agente',
  body: 'Ana hizo el pedido P-1',
};

const makeService = (options: { enabled?: boolean; rows?: unknown[]; adminUsers?: string[] } = {}) => {
  const repo = {
    query: jest.fn(async (): Promise<unknown[]> => options.rows ?? []),
    delete: jest.fn(async () => ({ affected: 1 })),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const sender = {
    enabled: options.enabled ?? true,
    publicKey: 'PUBLIC',
    send: jest.fn(async () => undefined),
  };
  const admins = new Set(options.adminUsers ?? []);
  const permissions = {
    execute: jest.fn(async (actor: { user_id: number }) =>
      admins.has(String(actor.user_id)) ? [...PERMISSION_KEYS] : ['canAccessPOS'],
    ),
  };
  const service = new PushNotificationsService(
    repo as unknown as Repository<PushSubscriptionEntity>,
    sender as unknown as WebPushSender,
    permissions as unknown as ResolveEffectivePermissionsAction,
  );
  return { service, repo, sender, permissions };
};

const payloadOf = (call: unknown[]) => JSON.parse(call[1] as string) as Record<string, unknown>;

describe('PushNotificationsService.publicKey', () => {
  it('con llaves: activo y con la pública', () => {
    expect(makeService().service.publicKey()).toEqual({ enabled: true, public_key: 'PUBLIC' });
  });

  it('sin llaves: apagado y sin llave', () => {
    expect(makeService({ enabled: false }).service.publicKey()).toEqual({
      enabled: false,
      public_key: null,
    });
  });
});

describe('PushNotificationsService.subscribe / unsubscribe', () => {
  const user = { user_id: 11, type: 'owner', account: 'user', company_id: 20 } as AuthUser;

  it('guarda o reasigna por endpoint con el usuario y el negocio del token', async () => {
    const h = makeService();
    await h.service.subscribe(user, 20, {
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
      user_agent: 'iPhone',
    });
    const [sql, params] = h.repo.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (endpoint) DO UPDATE');
    expect(params).toEqual([11, 20, 'owner', 'user', 'https://push.example/1', 'p', 'a', 'iPhone']);
  });

  it('sin user_agent guarda null', async () => {
    const h = makeService();
    await h.service.subscribe(user, 20, {
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const [, params] = h.repo.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params[7]).toBeNull();
  });

  it('quitar: solo la suscripción de ESE usuario', async () => {
    const h = makeService();
    await h.service.unsubscribe(user, 'https://push.example/1');
    expect(h.repo.delete).toHaveBeenCalledWith({
      endpoint: 'https://push.example/1',
      user_id: '11',
    });
  });
});

describe('PushNotificationsService.notifyAgentOrder', () => {
  it('apagado (sin llaves): no consulta ni envía', async () => {
    const h = makeService({ enabled: false, rows: [sub({ is_owner: true })] });
    await h.service.notifyAgentOrder(event);
    expect(h.repo.query).not.toHaveBeenCalled();
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('busca las suscripciones del negocio y las de sus dueños activos', async () => {
    const h = makeService();
    await h.service.notifyAgentOrder(event);
    const [sql, params] = h.repo.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("cm.role = 'owner'");
    expect(sql).toContain('cm.is_active = true');
    expect(sql).toContain('WHERE ps.company_id = $1 OR cm.user_id IS NOT NULL');
    expect(params).toEqual([20]);
  });

  it('el dueño en otra sucursal recibe el aviso con el nombre de la sucursal', async () => {
    const h = makeService({ rows: [sub({ user_type: 'owner', company_id: '5', is_owner: true })] });
    await h.service.notifyAgentOrder(event);
    expect(h.sender.send).toHaveBeenCalledTimes(1);
    const payload = payloadOf(h.sender.send.mock.calls[0] as unknown[]);
    expect(payload.title).toBe('Nuevo pedido del agente · La 28');
    expect(payload.url).toBe('/?notifications=open');
    expect(h.permissions.execute).not.toHaveBeenCalled();
  });

  it('empleado administrador del negocio: lo recibe y abre el pedido', async () => {
    const h = makeService({ rows: [sub()], adminUsers: ['11'] });
    await h.service.notifyAgentOrder(event);
    const payload = payloadOf(h.sender.send.mock.calls[0] as unknown[]);
    expect(payload.url).toBe('/reportes?tab=agente&order=10');
    expect(h.permissions.execute).toHaveBeenCalledWith({
      type: 'employee',
      account: 'employee',
      user_id: 11,
      company_id: 20,
    });
  });

  it('empleado sin nivel administrador: NO lo recibe (datos del cliente)', async () => {
    const h = makeService({ rows: [sub()] });
    await h.service.notifyAgentOrder(event);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('un no-dueño suscrito en otro negocio no recibe nada', async () => {
    const h = makeService({ rows: [sub({ company_id: '5' })], adminUsers: ['11'] });
    await h.service.notifyAgentOrder(event);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('resuelve los permisos una vez por usuario aunque tenga varios dispositivos', async () => {
    const h = makeService({
      rows: [sub(), sub({ id: '2', endpoint: 'https://push.example/2' })],
      adminUsers: ['11'],
    });
    await h.service.notifyAgentOrder(event);
    expect(h.permissions.execute).toHaveBeenCalledTimes(1);
    expect(h.sender.send).toHaveBeenCalledTimes(2);
  });

  it('envío exitoso: marca last_success_at', async () => {
    const h = makeService({ rows: [sub({ is_owner: true })] });
    await h.service.notifyAgentOrder(event);
    expect(h.repo.update).toHaveBeenCalledWith({ id: '1' }, { last_success_at: expect.any(Date) });
  });

  it('suscripción muerta (410): la borra', async () => {
    const h = makeService({ rows: [sub({ is_owner: true })] });
    h.sender.send.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    await h.service.notifyAgentOrder(event);
    expect(h.repo.delete).toHaveBeenCalledWith({ id: '1' });
  });

  it('otro error del servicio push: no borra y sigue con los demás', async () => {
    const h = makeService({
      rows: [sub({ is_owner: true }), sub({ id: '2', is_owner: true })],
    });
    h.sender.send.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    await h.service.notifyAgentOrder(event);
    expect(h.repo.delete).not.toHaveBeenCalled();
    expect(h.sender.send).toHaveBeenCalledTimes(2);
  });

  it('si la consulta falla, no lanza (best-effort)', async () => {
    const h = makeService();
    h.repo.query.mockRejectedValueOnce(new Error('db'));
    await expect(h.service.notifyAgentOrder(event)).resolves.toBeUndefined();
  });
});
