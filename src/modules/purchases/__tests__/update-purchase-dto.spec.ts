import { ValidationPipe } from '@nestjs/common';

import { UpdatePurchaseDto } from '../dto/update-purchase.dto';

/**
 * Regresión: el cliente PlacePos envía, por línea, subtotal/iva_amount/total
 * pre-calculados, y a nivel raíz client_operation_id. El server los recomputa
 * (líneas) / los usa para idempotencia (raíz), pero el DTO debe ACEPTARLOS —
 * antes los rechazaba con "property X should not exist".
 */
describe('UpdatePurchaseDto — acepta campos del cliente PlacePos', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const meta = { type: 'body' as const, metatype: UpdatePurchaseDto };

  it('no rechaza subtotal/iva_amount/total por línea ni client_operation_id', async () => {
    const payload = {
      invoice_date: '2026-05-12',
      invoice_number: 'F-1234',
      client_operation_id: '550e8400-e29b-41d4-a716-446655440000',
      lines: [
        {
          product_id: 1,
          packaging_qty: 2,
          unit_qty: 1,
          unit_price: 100,
          packaging_price: 100,
          iva_rate: 16,
          // Los 3 que antes rompían:
          subtotal: 200,
          iva_amount: 32,
          total: 232,
        },
      ],
    };

    const result = (await pipe.transform(payload, meta)) as UpdatePurchaseDto;

    expect(result.client_operation_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].product_id).toBe(1);
  });
});
