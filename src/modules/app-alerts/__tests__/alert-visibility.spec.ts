import { In, Like, MoreThanOrEqual, Not } from 'typeorm';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';

import { CountUnreadAlertsAction } from '../actions/count-unread-alerts.action';
import { FindAllAlertsAction } from '../actions/find-all-alerts.action';
import { MarkAlertReadAction } from '../actions/mark-alert-read.action';
import { MarkAllAlertsReadAction } from '../actions/mark-all-alerts-read.action';
import { AppAlertsController } from '../app-alerts.controller';
import type { AppAlertsService } from '../app-alerts.service';
import { toAppAlertResponseDto } from '../dto/app-alert-response.dto';
import { AlertSeverity, type AppAlert } from '../entities/app-alert.entity';
import { scopeWhere, singleCompanyScope, type AlertScope } from '../internal/alert-scope';
import { hiddenAlertPrefixFor } from '../internal/alert-visibility';
import { ResolveAlertScopeAction } from '../internal/resolve-alert-scope';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import { PERMISSION_KEYS } from '@/modules/roles/internal/permission-catalog';
import type { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import type { AuthUser } from '@/common/types/jwt-payload.type';

const owner = { user_id: 1, company_id: 13, type: 'owner' } as AuthUser;
const employee = { user_id: 3, company_id: 13, type: 'employee' } as AuthUser;
/** Dueño parado en el principal (13) con la sucursal 20. */
const ownerScope: AlertScope = { companyId: 13, hiddenTypePrefix: null, agentCompanyIds: [20] };

describe('hiddenAlertPrefixFor', () => {
  it('nivel administrador ve todo; el resto no ve las del agente', () => {
    expect(hiddenAlertPrefixFor(true)).toBeNull();
    expect(hiddenAlertPrefixFor(false)).toBe('AGENT_ORDER_');
  });
});

describe('scopeWhere', () => {
  it('un solo negocio: sus alertas (con o sin tipos ocultos)', () => {
    expect(scopeWhere(singleCompanyScope(13))).toEqual([{ company_id: '13' }]);
    expect(scopeWhere(singleCompanyScope(13, 'AGENT_ORDER_'), { is_read: false })).toEqual([
      { company_id: '13', type: Not(Like('AGENT_ORDER_%')), is_read: false },
    ]);
  });

  it('dueño con sucursales: su negocio + los pedidos del agente de las otras', () => {
    expect(scopeWhere(ownerScope, { is_read: false })).toEqual([
      { company_id: '13', is_read: false },
      { company_id: In(['20']), type: Like('AGENT_ORDER_%'), is_read: false },
    ]);
  });

  it('ignora el negocio activo y duplicados en la lista de sucursales', () => {
    expect(scopeWhere({ ...ownerScope, agentCompanyIds: [13, 20, 20] })[1]).toMatchObject({
      company_id: In(['20']),
    });
    expect(scopeWhere({ ...ownerScope, agentCompanyIds: [13] })).toHaveLength(1);
  });
});

describe('ResolveAlertScopeAction', () => {
  const make = (permissions: string[], memberIds: string[]) => {
    const resolve = { execute: jest.fn(() => Promise.resolve(permissions)) };
    const members = {
      find: jest.fn(() => Promise.resolve(memberIds.map((company_id) => ({ company_id })))),
    };
    return {
      action: new ResolveAlertScopeAction(
        resolve as unknown as ResolveEffectivePermissionsAction,
        members as unknown as Repository<CompanyMember>,
      ),
      members,
    };
  };

  it('dueño: incluye sus OTROS negocios activos', async () => {
    const h = make([...PERMISSION_KEYS], ['13', '20', '21']);
    await expect(h.action.execute(owner, 13)).resolves.toEqual({
      companyId: 13,
      hiddenTypePrefix: null,
      agentCompanyIds: [20, 21],
    });
    expect(h.members.find).toHaveBeenCalledWith({
      where: { user_id: '1', is_active: true },
      select: { company_id: true },
    });
  });

  it('empleado (aunque sea Administrador): solo su negocio', async () => {
    const h = make([...PERMISSION_KEYS], ['13', '20']);
    await expect(h.action.execute(employee, 13)).resolves.toEqual({
      companyId: 13,
      hiddenTypePrefix: null,
      agentCompanyIds: [],
    });
    expect(h.members.find).not.toHaveBeenCalled();
  });

  it('cajero/vendedor: oculta las del agente', async () => {
    const h = make(['canAccessPOS'], []);
    await expect(h.action.execute(employee, 13)).resolves.toMatchObject({
      hiddenTypePrefix: 'AGENT_ORDER_',
    });
  });
});

describe('FindAllAlertsAction / CountUnreadAlertsAction', () => {
  const repo = () => ({
    find: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
  });

  it('"Todas": no leídas siempre + leídas de los últimos 7 días, con el negocio de cada una', async () => {
    const r = repo();
    await new FindAllAlertsAction(r as unknown as Repository<AppAlert>).execute(
      singleCompanyScope(7),
      { unreadOnly: false, limit: 50, now: new Date('2026-10-31T15:00:00.000Z') },
    );
    expect(r.find).toHaveBeenCalledWith({
      where: [
        { company_id: '7', is_read: false },
        {
          company_id: '7',
          is_read: true,
          created_at: MoreThanOrEqual(new Date('2026-10-24T15:00:00.000Z')),
        },
      ],
      relations: { company: true },
      order: { created_at: 'DESC' },
      take: 50,
    });
    expect(r.count).toHaveBeenCalledWith({ where: [{ company_id: '7', is_read: false }] });
  });

  it('dueño: también trae los pedidos del agente de sus sucursales', async () => {
    const r = repo();
    await new FindAllAlertsAction(r as unknown as Repository<AppAlert>).execute(ownerScope, {
      unreadOnly: true,
      limit: 20,
    });
    expect(r.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          { company_id: '13', is_read: false },
          { company_id: In(['20']), type: Like('AGENT_ORDER_%'), is_read: false },
        ],
      }),
    );

    const c = repo();
    await new CountUnreadAlertsAction(c as unknown as Repository<AppAlert>).execute(ownerScope);
    expect(c.count).toHaveBeenCalledWith({
      where: [
        { company_id: '13', is_read: false },
        { company_id: In(['20']), type: Like('AGENT_ORDER_%'), is_read: false },
      ],
    });
  });
});

describe('marcar leídas dentro del alcance', () => {
  const makeDs = (found: Partial<AppAlert> | null) => {
    const manager = {
      findOne: jest.fn(() => Promise.resolve(found)),
      update: jest.fn(() => Promise.resolve({ affected: 2 })),
    };
    const ds = {
      transaction: (fn: (m: EntityManager) => Promise<unknown>) =>
        fn(manager as unknown as EntityManager),
    } as unknown as DataSource;
    return { ds, manager };
  };

  it('una: la busca en el alcance (incluye la sucursal) y la marca en SU negocio', async () => {
    const h = makeDs({ id: '9', company_id: '20', is_read: false });
    await new MarkAlertReadAction(h.ds).execute(9, ownerScope);
    expect(h.manager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: [
        { company_id: '13', id: '9' },
        { company_id: In(['20']), type: Like('AGENT_ORDER_%'), id: '9' },
      ],
    });
    expect(h.manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: '9', company_id: '20' },
      { is_read: true },
    );
  });

  it('una fuera del alcance → 404; ya leída → no escribe', async () => {
    await expect(
      new MarkAlertReadAction(makeDs(null).ds).execute(9, ownerScope),
    ).rejects.toBeInstanceOf(NotFoundException);
    const read = makeDs({ id: '9', company_id: '13', is_read: true });
    await new MarkAlertReadAction(read.ds).execute(9, ownerScope);
    expect(read.manager.update).not.toHaveBeenCalled();
  });

  it('todas: una actualización por condición del alcance y suma lo marcado', async () => {
    const h = makeDs(null);
    await expect(new MarkAllAlertsReadAction(h.ds).execute(ownerScope)).resolves.toEqual({
      marked_count: 4,
    });
    expect(h.manager.update).toHaveBeenCalledTimes(2);
  });
});

describe('AppAlertsController', () => {
  it('arma el alcance del usuario y lo usa en todo', async () => {
    const service = {
      findAll: jest.fn(() => Promise.resolve({ alerts: [], unread_count: 0 })),
      countUnread: jest.fn(() => Promise.resolve(0)),
      markRead: jest.fn(() => Promise.resolve()),
      markAllRead: jest.fn(() => Promise.resolve({ marked_count: 0 })),
    };
    const resolveScope = { execute: jest.fn(() => Promise.resolve(ownerScope)) };
    const controller = new AppAlertsController(
      service as unknown as AppAlertsService,
      resolveScope as unknown as ResolveAlertScopeAction,
    );
    await controller.findAll({}, 13, owner);
    await controller.unreadCount(13, owner);
    await controller.markRead(9, 13, owner);
    await controller.markAllRead(13, owner);
    expect(resolveScope.execute).toHaveBeenCalledWith(owner, 13);
    expect(service.findAll).toHaveBeenCalledWith(ownerScope, { unreadOnly: false, limit: 50 });
    expect(service.countUnread).toHaveBeenCalledWith(ownerScope);
    expect(service.markRead).toHaveBeenCalledWith(9, ownerScope);
    expect(service.markAllRead).toHaveBeenCalledWith(ownerScope);
  });
});

describe('toAppAlertResponseDto', () => {
  it('incluye título, severidad y el negocio (para mostrar la sucursal)', () => {
    const dto = toAppAlertResponseDto({
      id: '5',
      company_id: '20',
      company: { name: 'Esencia & Grano - la 28' },
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
      company_id: 20,
      company_name: 'Esencia & Grano - la 28',
      payload: { order_id: 10, message: 'Ana hizo el pedido P-1' },
    });
  });

  it('sin la relación cargada: company_name null', () => {
    const dto = toAppAlertResponseDto({
      id: '5',
      company_id: '13',
      type: 'X',
      severity: AlertSeverity.INFO,
      title: 't',
      message: 'm',
      is_read: true,
      metadata: null,
      created_at: new Date(),
    } as unknown as AppAlert);
    expect(dto.company_name).toBeNull();
  });
});
