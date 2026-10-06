import { toSaleResponseDto } from '../dto/sale-response.dto';
import type { SaleInvoice } from '../entities/sale-invoice.entity';

/**
 * El detalle del ticket (`GET /sales/:id` → `toSaleResponseDto`) debe exponer la
 * MESA/SALÓN del pedido (modo restaurante) para que el TicketViewer y el recibo
 * impreso la muestren. Snapshots (`table_name`/`salon_name`) para que sigan
 * visibles aunque la mesa/salón se archive luego. null cuando el pedido no tuvo
 * mesa (retail): el recibo entonces no pinta nada.
 */
const baseSale = (overrides: Partial<Record<string, unknown>> = {}): SaleInvoice =>
  ({
    id: '77',
    ticket_type: 'ORDER',
    ticket_number: 'PED-1',
    sale_number: null,
    total: '1000',
    cost: '600',
    profit: '400',
    margin: '40',
    customer_name: 'Juan Pérez',
    customer_id: '42',
    notes: null,
    created_by: 'kike',
    is_deleted: false,
    table_id: null,
    salon_id: null,
    table_name: null,
    salon_name: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as unknown as SaleInvoice;

describe('toSaleResponseDto — mesa/salón (modo restaurante)', () => {
  it('expone el snapshot de mesa y salón cuando el pedido se envió por salón', () => {
    const dto = toSaleResponseDto(
      baseSale({ table_name: 'Mesa 5', salon_name: 'Sur A' }),
      [],
      [],
      null,
    );
    expect(dto.tableName).toBe('Mesa 5');
    expect(dto.salonName).toBe('Sur A');
  });

  it('mesa suelta: tableName presente, salonName null', () => {
    const dto = toSaleResponseDto(
      baseSale({ table_name: 'Barra 1', salon_name: null }),
      [],
      [],
      null,
    );
    expect(dto.tableName).toBe('Barra 1');
    expect(dto.salonName).toBeNull();
  });

  it('pedido sin mesa (retail): ambos null', () => {
    const dto = toSaleResponseDto(baseSale(), [], [], null);
    expect(dto.tableName).toBeNull();
    expect(dto.salonName).toBeNull();
  });

  it('tolera un backend/entidad sin las columnas (undefined → null)', () => {
    const sale = baseSale();
    delete (sale as unknown as Record<string, unknown>).table_name;
    delete (sale as unknown as Record<string, unknown>).salon_name;
    const dto = toSaleResponseDto(sale, [], [], null);
    expect(dto.tableName).toBeNull();
    expect(dto.salonName).toBeNull();
  });
});
