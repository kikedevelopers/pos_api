import { toSaleResponseDto } from '../dto/sale-response.dto';
import type { SaleInvoice } from '../entities/sale-invoice.entity';

/**
 * Verifica que el mapper expone `customerDocNumber` (número de documento del
 * cliente, `customers.doc_number`). Lo pinta el recibo en la línea "Documento:"
 * SOLO cuando hay valor; `null` cuando el cliente no tiene documento o la venta
 * es de mostrador. Es el último parámetro posicional del mapper.
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

// Orden posicional del mapper hasta customerDocNumber:
//   sale, lines, payments, credit, creditNotes, pointsEnabled, customerPoints,
//   statusHistory, customerAddress, customerPhone, customerDocNumber
const dtoWithDoc = (docNumber: string | null) =>
  toSaleResponseDto(baseSale(), [], [], null, [], false, null, [], null, null, docNumber);

describe('toSaleResponseDto — customerDocNumber', () => {
  it('expone el número de documento del cliente cuando existe', () => {
    const dto = dtoWithDoc('1098765432');
    expect(dto.customerDocNumber).toBe('1098765432');
  });

  it('devuelve null cuando el cliente no tiene documento', () => {
    const dto = dtoWithDoc(null);
    expect(dto.customerDocNumber).toBeNull();
  });

  it('por defecto (param omitido) es null — resiliencia a mostrador', () => {
    const dto = toSaleResponseDto(baseSale({ customer_id: null }), [], [], null);
    expect(dto.customerDocNumber).toBeNull();
  });
});
