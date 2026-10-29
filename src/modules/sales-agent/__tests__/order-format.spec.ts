import { formatCop, formatOrderForOwner } from '../internal/order-format';
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
