import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreatePurchaseDto } from '../dto/create-purchase.dto';

/**
 * `payment_due_date` (plazo de pago) es opcional; si llega debe ser un día
 * `YYYY-MM-DD`. La regla "no anterior a hoy" vive en la action.
 */
describe('CreatePurchaseDto — payment_due_date', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const meta = { type: 'body' as const, metatype: CreatePurchaseDto };

  const base_payload = {
    supplier_id: 1,
    lines: [{ product_id: 1, packaging_qty: 1, unit_qty: 1, unit_price: 10, packaging_price: 10 }],
  };

  it('acepta la compra sin plazo de pago', async () => {
    const result = (await pipe.transform(base_payload, meta)) as CreatePurchaseDto;
    expect(result.payment_due_date).toBeUndefined();
  });

  it('acepta null (sin plazo)', async () => {
    const result = (await pipe.transform(
      { ...base_payload, payment_due_date: null },
      meta,
    )) as CreatePurchaseDto;
    expect(result.payment_due_date).toBeNull();
  });

  it('acepta un día YYYY-MM-DD', async () => {
    const result = (await pipe.transform(
      { ...base_payload, payment_due_date: '2026-11-06' },
      meta,
    )) as CreatePurchaseDto;
    expect(result.payment_due_date).toBe('2026-11-06');
  });

  it.each(['2026-11-06T23:59:59.000Z', '06/11/2026', '2026-1-6', 'mañana', 20261106])(
    'rechaza %p (no es un día YYYY-MM-DD)',
    async (value) => {
      await expect(
        pipe.transform({ ...base_payload, payment_due_date: value }, meta),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});
