import {
  formatCancelledNotice,
  formatCop,
  formatOrderForOwner,
  formatTakenRequestNotice,
} from '../internal/order-format';
import type { ClosedOrder } from '../internal/types';

describe('formatCop', () => {
  it('formatea pesos con separador de miles', () => {
    expect(formatCop(12000)).toBe('$ 12.000');
    expect(formatCop(1200000)).toBe('$ 1.200.000');
    expect(formatCop(0)).toBe('$ 0');
  });

  it('redondea a peso entero', () => {
    expect(formatCop(12000.6)).toBe('$ 12.001');
  });
});

describe('formatOrderForOwner', () => {
  const order: ClosedOrder = {
    items: [
      { name: 'Arroz Diana x libra', quantity: 2, unit_price: 3000, line_total: 6000 },
      { name: 'Aceite Girasol 1L', quantity: 1, unit_price: 12000, line_total: 12000 },
    ],
    total: 18000,
    customer_name: 'María',
    customer_phone: '3001234567',
    delivery: 'Calle 1 #2-3',
    channel: 'telegram',
    chat_id: '999',
    chat_display_name: 'María G',
  };

  it('lista cada línea con cantidad, precio y subtotal', () => {
    const text = formatOrderForOwner(order);
    expect(text).toContain('2 × Arroz Diana x libra');
    expect(text).toContain('$ 3.000');
    expect(text).toContain('$ 6.000');
    expect(text).toContain('TOTAL: $ 18.000');
  });

  it('incluye contacto, entrega y origen del chat', () => {
    const text = formatOrderForOwner(order);
    expect(text).toContain('Cliente: María');
    expect(text).toContain('Tel: 3001234567');
    expect(text).toContain('Entrega: Calle 1 #2-3');
    expect(text).toContain('María G · telegram');
  });

  it('cae al id del chat cuando no hay nombre visible', () => {
    const text = formatOrderForOwner({ ...order, chat_display_name: undefined });
    expect(text).toContain('telegram (999)');
  });
});

describe('formatOrderForOwner — referencia y pago', () => {
  const base: ClosedOrder = {
    items: [{ name: 'Arroz', quantity: 1, unit_price: 3000, line_total: 3000 }],
    total: 3000,
    channel: 'whatsapp',
    chat_id: '57300',
  };

  it('muestra la referencia del pedido en el título', () => {
    expect(formatOrderForOwner({ ...base, reference: 'P-4F2A9C1B' })).toMatch(
      /^🛒 NUEVO PEDIDO P-4F2A9C1B \(asistente de ventas\)/,
    );
  });

  it('sin referencia, título genérico', () => {
    expect(formatOrderForOwner(base)).toMatch(/^🛒 NUEVO PEDIDO \(asistente de ventas\)/);
  });

  it('incluye la forma de pago solo si se dio', () => {
    expect(formatOrderForOwner({ ...base, payment_method: 'Nequi' })).toContain('Pago: Nequi');
    expect(formatOrderForOwner(base)).not.toContain('Pago:');
  });
});

describe('avisos de cambios del cliente', () => {
  it('pedido actualizado: título propio con la misma referencia', () => {
    const text = formatOrderForOwner({
      reference: 'P-854A38BE',
      kind: 'updated',
      items: [{ name: 'ALMENDRA', quantity: 1, unit_price: 26500, line_total: 26500 }],
      total: 26500,
      channel: 'whatsapp',
      chat_id: '1',
    });
    expect(text.split('\n')[0]).toBe(
      '✏️ PEDIDO ACTUALIZADO POR EL CLIENTE P-854A38BE (asistente de ventas)',
    );
  });

  it('cancelación con y sin motivo', () => {
    expect(formatCancelledNotice('P-1', 'ya no')).toBe(
      '❌ EL CLIENTE CANCELÓ EL PEDIDO P-1 (asistente de ventas)\nMotivo: ya no',
    );
    expect(formatCancelledNotice('P-1', null)).toBe(
      '❌ EL CLIENTE CANCELÓ EL PEDIDO P-1 (asistente de ventas)',
    );
  });

  it('solicitud sobre pedido tomado: dice dónde está y qué pidió', () => {
    expect(
      formatTakenRequestNotice(
        { reference: 'P-1', status: 'taken', ticket: { number: 'VTA-9' } },
        'change',
        'quitar la nuez',
      ),
    ).toBe(
      '⚠️ SOLICITUD DEL CLIENTE sobre P-1 (ya está en el ticket VTA-9)\nQuiere CAMBIAR el pedido.\nPidió: quitar la nuez\nContáctalo para atenderla.',
    );
  });
});
