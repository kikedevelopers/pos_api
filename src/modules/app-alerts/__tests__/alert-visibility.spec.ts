import { Like, MoreThanOrEqual, Not } from 'typeorm';
import type { Repository } from 'typeorm';

import { CountUnreadAlertsAction } from '../actions/count-unread-alerts.action';
import { FindAllAlertsAction } from '../actions/find-all-alerts.action';
import { AppAlertsController } from '../app-alerts.controller';
import type { AppAlertsService } from '../app-alerts.service';
import { toAppAlertResponseDto } from '../dto/app-alert-response.dto';
import { AlertSeverity, type AppAlert } from '../entities/app-alert.entity';
import { AGENT_ORDER_ALERT_PREFIX, hiddenAlertPrefixFor } from '../internal/alert-visibility';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import { PERMISSION_KEYS } from '@/modules/roles/internal/permission-catalog';
import type { AuthUser } from '@/common/types/jwt-payload.type';

const user = { user_id: 3, company_id: 7, type: 'employee' } as AuthUser;

describe('hiddenAlertPrefixFor', () => {
  it('nivel administrador ve todo; el resto no ve las del agente', () => {
    expect(hiddenAlertPrefixFor(true)).toBeNull();
    expect(hiddenAlertPrefixFor(false)).toBe('AGENT_ORDER_');
  });
});

describe('FindAllAlertsAction / CountUnreadAlertsAction', () => {
  const repo = () => ({
    find: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
  });

  it('"Todas": las no leídas siempre y las leídas solo de los últimos 7 días', async () => {
    const r = repo();
    await new FindAllAlertsAction(r as unknown as Repository<AppAlert>).execute(7, {
      unreadOnly: false,
      limit: 50,
      now: new Date('2026-10-31T15:00:00.000Z'),
    });
    expect(r.find).toHaveBeenCalledWith({
      where: [
        { company_id: '7', is_read: false },
        {
          company_id: '7',
          is_read: true,
          created_at: MoreThanOrEqual(new Date('2026-10-24T15:00:00.000Z')),
        },
      ],
      order: { created_at: 'DESC' },
      take: 50,
    });
    expect(r.count).toHaveBeenCalledWith({ where: { company_id: '7', is_read: false } });
  });

  it('"Sin leer": solo las no leídas, sin límite de fecha', async () => {
    const r = repo();
    await new FindAllAlertsAction(r as unknown as Repository<AppAlert>).execute(7, {
      unreadOnly: true,
      limit: 50,
    });
    expect(r.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { company_id: '7', is_read: false } }),
    );
  });

  it('con prefijo oculto: excluye las del agente en lista y contador', async () => {
    const r = repo();
    await new FindAllAlertsAction(r as unknown as Repository<AppAlert>).execute(7, {
      unreadOnly: true,
      limit: 20,
      hiddenTypePrefix: AGENT_ORDER_ALERT_PREFIX,
    });
    const hidden = Not(Like('AGENT_ORDER_%'));
    expect(r.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { company_id: '7', type: hidden, is_read: false } }),
    );
    expect(r.count).toHaveBeenCalledWith({
      where: { company_id: '7', type: hidden, is_read: false },
    });

    const c = repo();
    await new CountUnreadAlertsAction(c as unknown as Repository<AppAlert>).execute(
      7,
      'AGENT_ORDER_',
    );
    expect(c.count).toHaveBeenCalledWith({
      where: { company_id: '7', is_read: false, type: hidden },
    });
  });
});

describe('AppAlertsController · visibilidad por permisos', () => {
  const make = (permissions: string[]) => {
    const service = {
      findAll: jest.fn(() => Promise.resolve({ alerts: [], unread_count: 0 })),
      countUnread: jest.fn(() => Promise.resolve(0)),
    };
    const resolve = { execute: jest.fn(() => Promise.resolve(permissions)) };
    const controller = new AppAlertsController(
      service as unknown as AppAlertsService,
      resolve as unknown as ResolveEffectivePermissionsAction,
    );
    return { controller, service };
  };

  it('administrador: ve las alertas del agente', async () => {
    const h = make([...PERMISSION_KEYS]);
    await h.controller.findAll({}, 7, user);
    await h.controller.unreadCount(7, user);
    expect(h.service.findAll).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ hiddenTypePrefix: null }),
    );
    expect(h.service.countUnread).toHaveBeenCalledWith(7, null);
  });

  it('cajero/vendedor: no ve las alertas del agente', async () => {
    const h = make(['canAccessPOS']);
    await h.controller.findAll({}, 7, user);
    await h.controller.unreadCount(7, user);
    expect(h.service.findAll).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ hiddenTypePrefix: 'AGENT_ORDER_' }),
    );
    expect(h.service.countUnread).toHaveBeenCalledWith(7, 'AGENT_ORDER_');
  });
});

describe('toAppAlertResponseDto', () => {
  it('incluye título y severidad (la UI los usa)', () => {
    const dto = toAppAlertResponseDto({
      id: '5',
      type: 'AGENT_ORDER_NEW',
      severity: AlertSeverity.INFO,
      title: 'Nuevo pedido del agente',
      message: 'Ana hizo el pedido P-1',
      is_read: false,
      metadata: { order_id: 10 },
      created_at: new Date('2026-10-31T13:00:00Z'),
    } as unknown as AppAlert);
    expect(dto).toMatchObject({
      id: 5,
      alert_type: 'AGENT_ORDER_NEW',
      title: 'Nuevo pedido del agente',
      severity: 'INFO',
      payload: { order_id: 10, message: 'Ana hizo el pedido P-1' },
    });
  });
});
