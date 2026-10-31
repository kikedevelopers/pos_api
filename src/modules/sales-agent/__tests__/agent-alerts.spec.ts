import { buildAgentOrderAlert } from '../internal/agent-alerts';

const data = {
  order_id: '10',
  reference: 'P-854A38BE',
  total: 48000,
  items_count: 2,
  customer_name: 'Enrique Pacheco',
  channel: 'whatsapp-web',
};

describe('buildAgentOrderAlert', () => {
  it('pedido nuevo: INFO, quién, referencia, total y productos', () => {
    expect(buildAgentOrderAlert('new', data)).toEqual({
      type: 'AGENT_ORDER_NEW',
      severity: 'INFO',
      title: 'Nuevo pedido del agente',
      message: 'Enrique Pacheco hizo el pedido P-854A38BE por $ 48.000 (2 productos).',
      metadata: {
        order_id: 10,
        reference: 'P-854A38BE',
        total: 48000,
        items_count: 2,
        customer_name: 'Enrique Pacheco',
        channel: 'whatsapp-web',
        event: 'new',
      },
    });
  });

  it('actualizado por el cliente', () => {
    const alert = buildAgentOrderAlert('updated', { ...data, total: 26500, items_count: 1 });
    expect(alert).toMatchObject({ type: 'AGENT_ORDER_UPDATED', severity: 'INFO' });
    expect(alert.message).toBe(
      'Enrique Pacheco cambió el pedido P-854A38BE: ahora $ 26.500 (1 producto).',
    );
  });

  it('cancelado: WARNING, con o sin motivo', () => {
    expect(
      buildAgentOrderAlert('cancelled', { ...data, detail: ' ya no\n lo quiero ' }),
    ).toMatchObject({
      type: 'AGENT_ORDER_CANCELLED',
      severity: 'WARNING',
      message: 'Enrique Pacheco canceló el pedido P-854A38BE: «ya no lo quiero»',
      metadata: expect.objectContaining({ detail: 'ya no lo quiero' }) as unknown,
    });
    expect(buildAgentOrderAlert('cancelled', data).message).toBe(
      'Enrique Pacheco canceló el pedido P-854A38BE.',
    );
  });

  it('solicitud sobre un pedido tomado', () => {
    expect(buildAgentOrderAlert('request', { ...data, detail: 'quitar la nuez' })).toMatchObject({
      type: 'AGENT_ORDER_REQUEST',
      severity: 'WARNING',
      title: 'El cliente pide un cambio',
      message:
        'Enrique Pacheco pide sobre el pedido P-854A38BE, que ya estaba tomado: «quitar la nuez»',
    });
  });

  it('sin nombre: "Un cliente"', () => {
    expect(buildAgentOrderAlert('new', { ...data, customer_name: '  ' }).message).toMatch(
      /^Un cliente hizo/,
    );
  });
});
