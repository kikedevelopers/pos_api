import { toSaleResponseDto } from '../dto/sale-response.dto';
import type { SaleInvoice } from '../entities/sale-invoice.entity';

/**
 * Verifica que el mapper expone `customerId` (paridad PlacePos `getTicketById`).
 * Lo usa el TicketViewer para resolver el teléfono y habilitar el envío del
 * ticket por WhatsApp. Los ids en pos_api son `bigint` (string en TypeORM), así
 * que debe salir convertido a número; y `null` cuando la venta es de mostrador.
 */
const baseSale = (overrides: Partial<Record<string, unknown>> = {}): SaleInvoice =>
  ({
    id: '77',
    ticket_type: 'SALE',
    ticket_number: 'VTA-1',
    sale_number: 'VTA-1',
    total: '1000',
    cost: '600',
    profit: '400',
    margin: '40',
    customer_name: 'Juan Pérez',
    customer_id: '42',
    notes: null,
    created_by: 'kike',
    is_deleted: false,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as unknown as SaleInvoice;

describe('toSaleResponseDto — customerId', () => {
  it('convierte el customer_id (bigint string) a número', () => {
    const dto = toSaleResponseDto(baseSale(), [], [], null);
    expect(dto.customerId).toBe(42);
    expect(typeof dto.customerId).toBe('number');
  });

  it('devuelve null cuando la venta es de mostrador (sin customer_id)', () => {
    const dto = toSaleResponseDto(baseSale({ customer_id: null }), [], [], null);
    expect(dto.customerId).toBeNull();
  });
});
