import {
  agentOrderUrl,
  buildAgentOrderPush,
  isGoneSubscription,
  NOTIFICATIONS_URL,
} from '../internal/push-message';

const event = {
  company_id: 20,
  company_name: 'Esencia & Grano - la 28',
  order_id: 10,
  title: 'Nuevo pedido del agente',
  body: 'Ana hizo el pedido P-7B0F3C1E por $ 18.000 (1 producto).',
};

describe('buildAgentOrderPush', () => {
  it('en el mismo negocio: abre el pedido en Reportes → Agente', () => {
    expect(buildAgentOrderPush(event, 20)).toEqual({
      title: 'Nuevo pedido del agente',
      body: event.body,
      url: '/reportes?tab=agente&order=10',
      tag: 'agent-order-10',
      company_id: 20,
      order_id: 10,
    });
  });

  it('en otra sucursal: el título lleva la sucursal y abre las notificaciones', () => {
    const message = buildAgentOrderPush(event, 5);
    expect(message.title).toBe('Nuevo pedido del agente · Esencia & Grano - la 28');
    expect(message.url).toBe(NOTIFICATIONS_URL);
    expect(message.company_id).toBe(20);
  });

  it('el mismo pedido usa la misma etiqueta (la notificación se reemplaza)', () => {
    expect(buildAgentOrderPush({ ...event, title: 'Pedido actualizado' }, 20).tag).toBe(
      buildAgentOrderPush(event, 20).tag,
    );
  });

  it('recorta un cuerpo largo y limpia espacios', () => {
    const body = buildAgentOrderPush({ ...event, body: `  ${'x'.repeat(400)}\n ` }, 20).body;
    expect(body).toHaveLength(180);
    expect(body.endsWith('…')).toBe(true);
  });

  it('agentOrderUrl', () => {
    expect(agentOrderUrl(77)).toBe('/reportes?tab=agente&order=77');
  });
});

describe('isGoneSubscription', () => {
  it.each([
    [404, true],
    [410, true],
    [400, false],
    [429, false],
    [500, false],
    [undefined, false],
  ])('%p → %p', (status, expected) => {
    expect(isGoneSubscription(status)).toBe(expected);
  });
});
