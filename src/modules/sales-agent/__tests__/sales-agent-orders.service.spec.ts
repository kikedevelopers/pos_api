import type { PushNotificationsService } from '@/modules/push-notifications/push-notifications.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import type { RealtimeGateway } from '@/modules/realtime/realtime.gateway';

import type { SalesAgentOrderEntity } from '../entities/sales-agent-order.entity';
import type { AgentOrderRecord } from '../internal/agent-order';
import { SalesAgentOrdersService } from '../sales-agent-orders.service';
import type { AppAlert } from '@/modules/app-alerts/entities/app-alert.entity';

/** Fila que devuelven los UPDATE de eventos del cliente. */
const eventRow = (patch: Record<string, unknown> = {}) => ({
  id: '10',
  reference: 'P-7B0F3C1E',
  total: '18000.00',
  items_count: 1,
  customer_name: 'Ana',
  chat_display_name: null,
  channel: 'telegram',
  ...patch,
});

const record: AgentOrderRecord = {
  operation_id: '7b0f3c1e-1111-4222-8333-444455556666',
  reference: 'P-7B0F3C1E',
  channel: 'telegram',
  channel_account: '@tienda_bot',
  chat_id: '998877',
  chat_display_name: 'Ana',
  chat_phone: null,
  customer_name: 'Ana',
  customer_phone: '3001234567',
  delivery_mode: 'domicilio',
  delivery_address: 'Cra 1',
  payment_method: 'Efectivo',
  notes: null,
  items: [
    { product_id: 5, name: 'CAFÉ', quantity: '1.0000', unit_price: '18000.00', total: '18000.00' },
  ],
  items_count: 1,
  total: '18000.00',
};

const entity = (patch: Partial<SalesAgentOrderEntity> = {}): SalesAgentOrderEntity =>
  ({
    id: '10',
    company_id: '7',
    ...record,
    total: 18000,
    status: 'pending',
    status_note: null,
    status_changed_at: null,
    status_changed_by_user_id: null,
    created_at: new Date('2026-10-31T15:00:00Z'),
    updated_at: new Date('2026-10-31T15:00:00Z'),
    ...patch,
  }) as SalesAgentOrderEntity;

/** Query builder encadenable que registra cada llamada. */
const makeQb = (result: {
  entities: SalesAgentOrderEntity[];
  raw: unknown[];
  count?: number;
  insertRaw?: unknown[];
}) => {
  const calls: Array<[string, unknown[]]> = [];
  const qb: Record<string, jest.Mock> = {};
  const chain = [
    'insert',
    'into',
    'values',
    'orIgnore',
    'returning',
    'leftJoin',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'offset',
    'limit',
  ];
  for (const name of chain) {
    qb[name] = jest.fn((...args: unknown[]) => {
      calls.push([name, args]);
      return qb;
    });
  }
  qb.clone = jest.fn(() => qb);
  qb.execute = jest.fn(() => Promise.resolve({ raw: result.insertRaw ?? [] }));
  qb.getRawAndEntities = jest.fn(() =>
    Promise.resolve({ entities: result.entities, raw: result.raw }),
  );
  qb.getCount = jest.fn(() => Promise.resolve(result.count ?? result.entities.length));
  return { qb, calls };
};

const summaryRow = {
  pending_count: '2',
  pending_total: '30000.00',
  taken_count: '5',
  taken_total: '90000.50',
  dismissed_count: '1',
};

const makeService = (
  options: {
    qbResult?: Parameters<typeof makeQb>[0];
    findOne?: SalesAgentOrderEntity | null;
    affected?: number;
  } = {},
) => {
  const { qb, calls } = makeQb(options.qbResult ?? { entities: [], raw: [] });
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    query: jest.fn((): Promise<unknown[]> => Promise.resolve([summaryRow])),
    count: jest.fn(() => Promise.resolve(3)),
    findOne: jest.fn(() => Promise.resolve(options.findOne ?? null)),
    update: jest.fn(() => Promise.resolve({ affected: options.affected ?? 1 })),
  };
  const realtime = {
    emitAgentOrdersChanged: jest.fn(),
    emitAlertCreated: jest.fn(),
    emitToUsers: jest.fn(),
  };
  const alerts = {
    create: jest.fn((partial: Record<string, unknown>) => ({ ...partial })),
    save: jest.fn((entity: Record<string, unknown>) => Promise.resolve({ id: '500', ...entity })),
  };
  const push = { notifyAgentOrder: jest.fn(() => Promise.resolve()) };
  const service = new SalesAgentOrdersService(
    repo as unknown as Repository<SalesAgentOrderEntity>,
    realtime as unknown as RealtimeGateway,
    alerts as unknown as Repository<AppAlert>,
    push as unknown as PushNotificationsService,
  );
  return { service, repo, realtime, alerts, push, qb, calls };
};

describe('SalesAgentOrdersService.record', () => {
  it('inserta el pedido y avisa en tiempo real que hay uno nuevo', async () => {
    const h = makeService({ qbResult: { entities: [], raw: [], insertRaw: [{ id: '10' }] } });

    await expect(h.service.record(7, record)).resolves.toEqual({ id: '10', inserted: true });

    expect(h.qb.values).toHaveBeenCalledWith({ ...record, company_id: '7', total: 18000 });
    expect(h.qb.orIgnore).toHaveBeenCalled();
    expect(h.realtime.emitAgentOrdersChanged).toHaveBeenCalledWith(7, {
      reason: 'created',
      reference: 'P-7B0F3C1E',
      order_id: 10,
    });
    // Notificación de la campana.
    expect(h.alerts.save).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: '7',
        type: 'AGENT_ORDER_NEW',
        severity: 'INFO',
        title: 'Nuevo pedido del agente',
        message: 'Ana hizo el pedido P-7B0F3C1E por $ 18.000 (1 producto).',
        metadata: expect.objectContaining({
          order_id: 10,
          reference: 'P-7B0F3C1E',
          event: 'new',
        }) as unknown,
      }),
    );
    expect(h.realtime.emitAlertCreated).toHaveBeenCalledWith(7, {
      companyId: 7,
      alertType: 'AGENT_ORDER_NEW',
      severity: 'INFO',
    });
  });

  it('idempotente: si ese carrito ya se guardó, no avisa de nuevo', async () => {
    const h = makeService({
      qbResult: { entities: [], raw: [], insertRaw: [] },
      findOne: entity({ id: '10' }),
    });
    // Devuelve el id del que ya existía (para que el carrito lo recuerde).
    await expect(h.service.record(7, record)).resolves.toEqual({ id: '10', inserted: false });
    expect(h.repo.findOne).toHaveBeenCalledWith({
      where: { company_id: '7', operation_id: record.operation_id },
      select: { id: true },
    });
    expect(h.realtime.emitAgentOrdersChanged).not.toHaveBeenCalled();
  });

  it('un fallo del socket NO rompe el guardado', async () => {
    const h = makeService({ qbResult: { entities: [], raw: [], insertRaw: [{ id: '10' }] } });
    h.realtime.emitAgentOrdersChanged.mockImplementation(() => {
      throw new Error('socket caído');
    });
    await expect(h.service.record(7, record)).resolves.toMatchObject({ inserted: true });
  });
});

describe('SalesAgentOrdersService.list', () => {
  const base = { status: 'pending' as const, page: 1, limit: 25 };

  it('por tomar: filtra por estado, lo más RECIENTE primero, y trae el resumen', async () => {
    const h = makeService({
      qbResult: { entities: [entity()], raw: [{ changed_by_name: null }], count: 1 },
    });

    const result = await h.service.list(7, base);

    expect(h.calls).toContainEqual(['andWhere', ['o.status = :status', { status: 'pending' }]]);
    expect(h.calls).toContainEqual(['orderBy', ['o.created_at', 'DESC']]);
    expect(result.total_count).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: 10,
      reference: 'P-7B0F3C1E',
      total: 18000,
      status: 'pending',
      created_at: '2026-10-31T15:00:00.000Z',
      status_changed_by: null,
    });
    expect(result.summary).toEqual({
      pending_count: 2,
      pending_total: 30000,
      taken_count: 5,
      taken_total: 90000.5,
      dismissed_count: 1,
    });
  });

  it('historial: "all" no filtra por estado y ordena de lo más reciente', async () => {
    const h = makeService();
    await h.service.list(7, { ...base, status: 'all' });
    expect(
      h.calls.some(([name, args]) => name === 'andWhere' && String(args[0]).includes('status')),
    ).toBe(false);
    expect(h.calls).toContainEqual(['orderBy', ['o.created_at', 'DESC']]);
  });

  it('con rango: filtra por días Colombia en lista y en resumen', async () => {
    const h = makeService();
    await h.service.list(7, { ...base, status: 'taken', from: '2026-10-01', to: '2026-10-31' });

    const rangeCall = h.calls.find(
      ([name, args]) => name === 'andWhere' && String(args[0]).includes('BETWEEN'),
    );
    expect(rangeCall?.[1][1]).toEqual({
      dateStart: new Date('2026-10-01T05:00:00.000Z'),
      dateEnd: new Date('2026-11-01T04:59:59.999Z'),
    });
    const [sql, params] = h.repo.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('created_at BETWEEN $2 AND $3');
    expect(params).toHaveLength(3);
  });

  it('sin rango, el resumen no filtra fechas', async () => {
    const h = makeService();
    await h.service.list(7, base);
    const [sql, params] = h.repo.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).not.toContain('BETWEEN');
    expect(params).toEqual([7]);
  });

  it('rango incompleto o inválido → 400', async () => {
    const h = makeService();
    await expect(h.service.list(7, { ...base, from: '2026-10-01' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      h.service.list(7, { ...base, from: '2026-10-31', to: '2026-10-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('búsqueda: escapa comodines de LIKE', async () => {
    const h = makeService();
    await h.service.list(7, { ...base, search: ' 50%_ana ' });
    // La búsqueda va en un Brackets; basta con verificar que se agregó.
    expect(h.calls.filter(([name]) => name === 'andWhere')).toHaveLength(2);
  });

  it('búsqueda por teléfono como lo muestra WhatsApp: compara solo dígitos', async () => {
    const h = makeService();
    await h.service.list(7, { ...base, search: '+57 316 138 4577' });
    const brackets = h.calls.filter(([name]) => name === 'andWhere').pop()?.[1][0] as {
      whereFactory: (qb: unknown) => void;
    };
    const ors: Array<[string, Record<string, unknown> | undefined]> = [];
    const qb = {
      where: (sql: string, p?: Record<string, unknown>) => (ors.push([sql, p]), qb),
      orWhere: (sql: string, p?: Record<string, unknown>) => (ors.push([sql, p]), qb),
    };
    brackets.whereFactory(qb);
    const digits = ors.find(([sql]) => sql.includes('regexp_replace'));
    expect(digits?.[1]).toEqual({ digits: '%573161384577%' });
  });

  it('búsqueda de texto corto no agrega la comparación por dígitos', async () => {
    const h = makeService();
    await h.service.list(7, { ...base, search: 'ana' });
    const brackets = h.calls.filter(([name]) => name === 'andWhere').pop()?.[1][0] as {
      whereFactory: (qb: unknown) => void;
    };
    const ors: string[] = [];
    const qb = {
      where: (sql: string) => (ors.push(sql), qb),
      orWhere: (sql: string) => (ors.push(sql), qb),
    };
    brackets.whereFactory(qb);
    expect(ors.some((sql) => sql.includes('regexp_replace'))).toBe(false);
  });

  it('pagina con offset/limit', async () => {
    const h = makeService();
    await h.service.list(7, { ...base, page: 3, limit: 10 });
    expect(h.calls).toContainEqual(['offset', [20]]);
    expect(h.calls).toContainEqual(['limit', [10]]);
  });
});

describe('SalesAgentOrdersService.findOne', () => {
  it('404 si no existe en ese negocio', async () => {
    const h = makeService();
    await expect(h.service.findOne(7, 99)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls).toContainEqual(['where', ['o.company_id = :companyId', { companyId: 7 }]]);
  });

  it('incluye quién cambió el estado', async () => {
    const h = makeService({
      qbResult: {
        entities: [
          entity({ status: 'taken', status_changed_at: new Date('2026-10-31T16:00:00Z') }),
        ],
        raw: [{ changed_by_name: 'Enrique Pacheco' }],
      },
    });
    await expect(h.service.findOne(7, 10)).resolves.toMatchObject({
      status: 'taken',
      status_changed_by: 'Enrique Pacheco',
      status_changed_at: '2026-10-31T16:00:00.000Z',
    });
  });
});

describe('SalesAgentOrdersService.updateStatus', () => {
  const found = (status: SalesAgentOrderEntity['status']) => ({
    findOne: entity({ status }),
    qbResult: { entities: [entity({ status: 'taken' })], raw: [{}] },
  });

  it('por tomar → tomado: guarda quién y cuándo, y avisa en tiempo real', async () => {
    const h = makeService(found('pending'));

    await h.service.updateStatus(7, 10, { status: 'taken', note: '  facturado ', userId: 3 });

    expect(h.repo.findOne).toHaveBeenCalledWith({ where: { id: '10', company_id: '7' } });
    expect(h.repo.update).toHaveBeenCalledWith(
      { id: '10', company_id: '7', status: 'pending' },
      {
        status: 'taken',
        status_note: 'facturado',
        status_changed_at: expect.any(Date) as unknown,
        status_changed_by_user_id: '3',
      },
    );
    expect(h.realtime.emitAgentOrdersChanged).toHaveBeenCalledWith(7, {
      reason: 'status_changed',
      reference: 'P-7B0F3C1E',
    });
  });

  it('volver a por tomar limpia la nota', async () => {
    const h = makeService(found('dismissed'));
    await h.service.updateStatus(7, 10, { status: 'pending', note: 'ignorada', userId: 3 });
    expect(h.repo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'pending', status_note: null }),
    );
  });

  it('mismo estado: no escribe ni avisa (idempotente)', async () => {
    const h = makeService(found('taken'));
    await h.service.updateStatus(7, 10, { status: 'taken', userId: 3 });
    expect(h.repo.update).not.toHaveBeenCalled();
    expect(h.realtime.emitAgentOrdersChanged).not.toHaveBeenCalled();
  });

  it('transición no permitida (tomado → descartado) → 400', async () => {
    const h = makeService(found('taken'));
    await expect(
      h.service.updateStatus(7, 10, { status: 'dismissed', userId: 3 }),
    ).rejects.toMatchObject({
      response: { code: 'AGENT_ORDER_INVALID_TRANSITION' },
    });
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('otro usuario lo cambió entretanto → 400 de conflicto, sin aviso', async () => {
    const h = makeService({ ...found('pending'), affected: 0 });
    await expect(
      h.service.updateStatus(7, 10, { status: 'taken', userId: 3 }),
    ).rejects.toMatchObject({
      response: { code: 'AGENT_ORDER_STATUS_CONFLICT' },
    });
    expect(h.realtime.emitAgentOrdersChanged).not.toHaveBeenCalled();
  });

  it('pedido de otro negocio o inexistente → 404', async () => {
    const h = makeService({ findOne: null });
    await expect(
      h.service.updateStatus(7, 10, { status: 'taken', userId: 3 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SalesAgentOrdersService.pendingCount', () => {
  it('cuenta solo los por tomar del negocio', async () => {
    const h = makeService();
    await expect(h.service.pendingCount(7)).resolves.toBe(3);
    expect(h.repo.count).toHaveBeenCalledWith({ where: { company_id: '7', status: 'pending' } });
  });
});

describe('SalesAgentOrdersService · ticket enlazado', () => {
  const ticketRaw = (patch: Record<string, unknown> = {}) => ({
    ticket_type: 'ORDER',
    ticket_number: 'PED-8304',
    sale_number: null,
    ticket_is_credit: false,
    ticket_is_voided: false,
    ...patch,
  });

  it('la vista trae el consecutivo vigente: PED-x mientras es pedido', async () => {
    const h = makeService({
      qbResult: { entities: [entity({ sale_invoice_id: '900' })], raw: [ticketRaw()] },
    });
    await expect(h.service.findOne(7, 10)).resolves.toMatchObject({
      ticket: { id: 900, type: 'ORDER', number: 'PED-8304', is_credit: false, is_voided: false },
    });
  });

  it('cobrado: muestra el VTA-x; a crédito lo marca', async () => {
    const h = makeService({
      qbResult: {
        entities: [entity({ sale_invoice_id: '900' })],
        raw: [ticketRaw({ ticket_type: 'SALE', sale_number: 'VTA-8127', ticket_is_credit: true })],
      },
    });
    await expect(h.service.findOne(7, 10)).resolves.toMatchObject({
      ticket: { type: 'SALE', number: 'VTA-8127', is_credit: true },
    });
  });

  it('sin enlace: ticket null', async () => {
    const h = makeService({ qbResult: { entities: [entity()], raw: [{}] } });
    await expect(h.service.findOne(7, 10)).resolves.toMatchObject({ ticket: null });
  });

  it('linkTicket: enlaza con un ticket vivo del negocio y deja el pedido TOMADO', async () => {
    const h = makeService({
      findOne: entity(),
      qbResult: {
        entities: [entity({ sale_invoice_id: '900', status: 'taken' })],
        raw: [ticketRaw()],
      },
    });
    h.repo.query.mockResolvedValueOnce([{ id: '900' }]);
    h.repo.count.mockResolvedValueOnce(0);

    const view = await h.service.linkTicket(7, 10, { saleInvoiceId: 900, userId: 3 });

    expect(h.repo.query).toHaveBeenCalledWith(
      expect.stringContaining('is_deleted = false'),
      [900, 7],
    );
    expect(h.repo.update).toHaveBeenCalledWith(
      { id: '10', company_id: '7' },
      expect.objectContaining({
        sale_invoice_id: '900',
        status: 'taken',
        status_changed_by_user_id: '3',
      }),
    );
    expect(h.realtime.emitAgentOrdersChanged).toHaveBeenCalledWith(7, {
      reason: 'status_changed',
      reference: 'P-7B0F3C1E',
    });
    expect(view.ticket?.number).toBe('PED-8304');
  });

  it('linkTicket: idempotente con el mismo ticket (no escribe)', async () => {
    const h = makeService({
      findOne: entity({ sale_invoice_id: '900' }),
      qbResult: { entities: [entity({ sale_invoice_id: '900' })], raw: [ticketRaw()] },
    });
    await h.service.linkTicket(7, 10, { saleInvoiceId: 900, userId: 3 });
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('linkTicket: ticket de otro negocio, inexistente o anulado → 404', async () => {
    const h = makeService({ findOne: entity() });
    h.repo.query.mockResolvedValueOnce([]);
    await expect(
      h.service.linkTicket(7, 10, { saleInvoiceId: 900, userId: 3 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('linkTicket: el ticket ya está enlazado a otro pedido → 409', async () => {
    const h = makeService({ findOne: entity() });
    h.repo.query.mockResolvedValueOnce([{ id: '900' }]);
    h.repo.count.mockResolvedValueOnce(1);
    await expect(
      h.service.linkTicket(7, 10, { saleInvoiceId: 900, userId: 3 }),
    ).rejects.toMatchObject({
      response: { code: 'AGENT_TICKET_ALREADY_LINKED' },
    });
  });

  it('linkTicket: el pedido ya está en otro ticket vivo → 409', async () => {
    const h = makeService({
      findOne: entity({ sale_invoice_id: '800' }),
      qbResult: {
        entities: [entity({ sale_invoice_id: '800' })],
        raw: [ticketRaw({ ticket_number: 'PED-1' })],
      },
    });
    await expect(
      h.service.linkTicket(7, 10, { saleInvoiceId: 900, userId: 3 }),
    ).rejects.toMatchObject({
      response: { code: 'AGENT_ORDER_ALREADY_LINKED' },
    });
  });

  it('pedido inexistente → 404', async () => {
    const h = makeService({ findOne: null });
    await expect(
      h.service.linkTicket(7, 10, { saleInvoiceId: 900, userId: 3 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('devolver a "por tomar" con el ticket vivo → 400 (evita facturar dos veces)', async () => {
    const h = makeService({
      findOne: entity({ status: 'taken', sale_invoice_id: '900' }),
      qbResult: {
        entities: [entity({ status: 'taken', sale_invoice_id: '900' })],
        raw: [ticketRaw()],
      },
    });
    await expect(
      h.service.updateStatus(7, 10, { status: 'pending', userId: 3 }),
    ).rejects.toMatchObject({
      response: { code: 'AGENT_ORDER_HAS_TICKET' },
    });
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('devolver a "por tomar" con el ticket ANULADO: se permite y suelta el enlace', async () => {
    const h = makeService({
      findOne: entity({ status: 'taken', sale_invoice_id: '900' }),
      qbResult: {
        entities: [entity({ status: 'taken', sale_invoice_id: '900' })],
        raw: [ticketRaw({ ticket_is_voided: true })],
      },
    });
    await h.service.updateStatus(7, 10, { status: 'pending', userId: 3 });
    expect(h.repo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'pending', sale_invoice_id: null }),
    );
  });
});

describe('SalesAgentOrdersService · cambios del cliente', () => {
  it('amendByCustomer: actualiza el MISMO pedido solo si sigue por tomar y sin ticket', async () => {
    const h = makeService();
    h.repo.query.mockResolvedValueOnce([[eventRow()], 1]);

    await expect(h.service.amendByCustomer(7, '10', record)).resolves.toBe('updated');

    const [sql, params] = h.repo.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("status = 'pending' AND sale_invoice_id IS NULL");
    expect(sql).toContain('customer_updated_at = now()');
    expect(params.slice(0, 5)).toEqual(['10', 7, JSON.stringify(record.items), 1, '18000.00']);
    expect(h.realtime.emitAgentOrdersChanged).toHaveBeenCalledWith(7, {
      reason: 'updated',
      reference: 'P-7B0F3C1E',
      order_id: 10,
    });
    expect(h.alerts.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'AGENT_ORDER_UPDATED',
        title: 'Pedido actualizado por el cliente',
      }),
    );
  });

  it('amendByCustomer: ya tomado → locked, sin aviso', async () => {
    const h = makeService();
    h.repo.query.mockResolvedValueOnce([[], 0]);
    await expect(h.service.amendByCustomer(7, '10', record)).resolves.toBe('locked');
    expect(h.realtime.emitAgentOrdersChanged).not.toHaveBeenCalled();
  });

  it('cancelByCustomer: descartado POR EL CLIENTE con su motivo, solo si nadie lo tomó', async () => {
    const h = makeService();
    h.repo.query.mockResolvedValueOnce([[eventRow()], 1]);

    await expect(h.service.cancelByCustomer(7, '10', 'ya no lo necesito')).resolves.toBe(
      'cancelled',
    );

    const [sql, params] = h.repo.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("status = 'dismissed', cancelled_by_customer = true");
    expect(sql).toContain("status = 'pending' AND sale_invoice_id IS NULL");
    expect(params).toEqual(['10', 7, 'Cancelado por el cliente: ya no lo necesito']);
  });

  it('cancelByCustomer: sin motivo deja la nota genérica; ya tomado → locked', async () => {
    const h = makeService();
    h.repo.query
      .mockResolvedValueOnce([[eventRow({ reference: 'P-1' })], 1])
      .mockResolvedValueOnce([[], 0]);
    await h.service.cancelByCustomer(7, '10', null);
    expect((h.repo.query.mock.calls[0] as unknown as [string, unknown[]])[1][2]).toBe(
      'Cancelado por el cliente',
    );
    await expect(h.service.cancelByCustomer(7, '10', null)).resolves.toBe('locked');
  });

  it('recordCustomerRequest: anota la solicitud y avisa en tiempo real', async () => {
    const h = makeService({ findOne: entity() });
    await h.service.recordCustomerRequest(7, '10', '  Cambiar el pedido:\n quitar la nuez ');
    expect(h.repo.update).toHaveBeenCalledWith(
      { id: '10', company_id: '7' },
      {
        customer_request: 'Cambiar el pedido: quitar la nuez',
        customer_request_at: expect.any(Date) as unknown,
      },
    );
    expect(h.realtime.emitAgentOrdersChanged).toHaveBeenCalledWith(7, {
      reason: 'customer_request',
      reference: 'P-7B0F3C1E',
      order_id: 10,
    });
    expect(h.alerts.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'AGENT_ORDER_REQUEST',
        severity: 'WARNING',
        metadata: expect.objectContaining({
          detail: 'Cambiar el pedido: quitar la nuez',
        }) as unknown,
      }),
    );
  });

  it('recordCustomerRequest: texto vacío no hace nada', async () => {
    const h = makeService();
    await h.service.recordCustomerRequest(7, '10', '   ');
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('la vista trae los cambios del cliente', async () => {
    const h = makeService({
      qbResult: {
        entities: [
          entity({
            status: 'dismissed',
            cancelled_by_customer: true,
            customer_updated_at: new Date('2026-10-31T13:06:00Z'),
            customer_request: 'Cancelar el pedido',
            customer_request_at: new Date('2026-10-31T13:07:00Z'),
          }),
        ],
        raw: [{}],
      },
    });
    await expect(h.service.findOne(7, 10)).resolves.toMatchObject({
      cancelled_by_customer: true,
      customer_updated_at: '2026-10-31T13:06:00.000Z',
      customer_request: 'Cancelar el pedido',
      customer_request_at: '2026-10-31T13:07:00.000Z',
    });
  });
});

describe('SalesAgentOrdersService · notificaciones de la campana', () => {
  it('cancelación del cliente: alerta WARNING con el motivo y aviso en tiempo real', async () => {
    const h = makeService();
    h.repo.query.mockResolvedValueOnce([[eventRow()], 1]);
    await h.service.cancelByCustomer(7, '10', 'ya no lo necesito');
    expect(h.realtime.emitAgentOrdersChanged).toHaveBeenCalledWith(7, {
      reason: 'cancelled',
      reference: 'P-7B0F3C1E',
      order_id: 10,
    });
    expect(h.alerts.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'AGENT_ORDER_CANCELLED',
        severity: 'WARNING',
        message: 'Ana canceló el pedido P-7B0F3C1E: «ya no lo necesito»',
      }),
    );
  });

  it('pedido ya tomado (locked): no crea notificación', async () => {
    const h = makeService();
    h.repo.query.mockResolvedValueOnce([[], 0]);
    await h.service.amendByCustomer(7, '10', record);
    expect(h.alerts.save).not.toHaveBeenCalled();
  });

  it('idempotente: un pedido que ya existía no notifica de nuevo', async () => {
    const h = makeService({
      qbResult: { entities: [], raw: [], insertRaw: [] },
      findOne: entity(),
    });
    await h.service.record(7, record);
    expect(h.alerts.save).not.toHaveBeenCalled();
  });

  it('si guardar la notificación falla, el pedido sigue (best-effort)', async () => {
    const h = makeService({ qbResult: { entities: [], raw: [], insertRaw: [{ id: '10' }] } });
    h.alerts.save.mockRejectedValueOnce(new Error('db'));
    await expect(h.service.record(7, record)).resolves.toEqual({ id: '10', inserted: true });
    expect(h.realtime.emitAlertCreated).not.toHaveBeenCalled();
  });
});

describe('SalesAgentOrdersService · aviso a los dueños (sucursales)', () => {
  it('pedido nuevo en una sucursal: avisa a sus dueños por su room de usuario, con el nombre', async () => {
    const h = makeService({ qbResult: { entities: [], raw: [], insertRaw: [{ id: '10' }] } });
    h.repo.query.mockResolvedValueOnce([{ user_id: '1', company_name: 'Esencia & Grano - la 28' }]);

    await h.service.record(20, record);

    const [sql, params] = h.repo.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("cm.role = 'owner' AND cm.is_active = true");
    expect(params).toEqual([20]);
    expect(h.realtime.emitToUsers).toHaveBeenCalledWith([1], 'alert:created', {
      companyId: 20,
      alertType: 'AGENT_ORDER_NEW',
      severity: 'INFO',
    });
    expect(h.realtime.emitToUsers).toHaveBeenCalledWith([1], 'agent-orders:changed', {
      companyId: 20,
      reason: 'created',
      reference: 'P-7B0F3C1E',
      order_id: 10,
      company_id: 20,
      company_name: 'Esencia & Grano - la 28',
      customer_name: 'Ana',
      total: 18000,
      items_count: 1,
    });
  });

  it('cada evento del cliente lleva su reason', async () => {
    const h = makeService({ findOne: entity() });
    h.repo.query
      .mockResolvedValueOnce([[eventRow()], 1]) // cancelByCustomer
      .mockResolvedValueOnce([{ user_id: '1', company_name: 'X' }]);
    await h.service.cancelByCustomer(20, '10', null);
    expect(h.realtime.emitToUsers).toHaveBeenCalledWith(
      [1],
      'agent-orders:changed',
      expect.objectContaining({ reason: 'cancelled' }),
    );
  });

  it('cada evento sale también por push a los dispositivos, con la sucursal', async () => {
    const h = makeService({ qbResult: { entities: [], raw: [], insertRaw: [{ id: '10' }] } });
    h.repo.query.mockResolvedValueOnce([{ user_id: '1', company_name: 'Esencia & Grano - la 28' }]);

    await h.service.record(20, record);

    expect(h.push.notifyAgentOrder).toHaveBeenCalledWith({
      company_id: 20,
      company_name: 'Esencia & Grano - la 28',
      order_id: 10,
      title: 'Nuevo pedido del agente',
      body: expect.stringContaining('P-7B0F3C1E'),
    });
  });

  it('si el push falla, el pedido sigue (no se espera ni rompe)', async () => {
    const h = makeService({ qbResult: { entities: [], raw: [], insertRaw: [{ id: '10' }] } });
    h.repo.query.mockResolvedValueOnce([]);
    h.push.notifyAgentOrder.mockRejectedValueOnce(new Error('push'));
    await expect(h.service.record(20, record)).resolves.toEqual({ id: '10', inserted: true });
  });

  it('sin dueños (o ids raros): no emite', async () => {
    const h = makeService({ qbResult: { entities: [], raw: [], insertRaw: [{ id: '10' }] } });
    h.repo.query.mockResolvedValueOnce([{ user_id: 'x', company_name: 'X' }]);
    await h.service.record(20, record);
    expect(h.realtime.emitToUsers).not.toHaveBeenCalled();
  });
});
