import { ValidationPipe } from '@nestjs/common';

import { CreateSaleDto } from '../dto/create-sale.dto';

/**
 * Verifica el fix: campos monetarios derivados (profit/total/cost) que llegan
 * con más de 2 decimales (ventas a granel: quantity fraccionaria) ya NO son
 * rechazados, sino redondeados a la escala de su columna antes de validar.
 */
describe('CreateSaleDto — redondeo de decimales derivados', () => {
  // Mismo pipe que en main.ts.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const meta = { type: 'body' as const, metatype: CreateSaleDto };

  it('acepta y redondea profit/total con >2 decimales (granel)', async () => {
    // profit línea = (999.99 - 666.67) * 0.255 = 84.99915  -> 5 decimales
    // total  línea = 999.99 * 0.255            = 254.99745 -> 5 decimales
    const payload = {
      items: [
        {
          item_id: 1,
          name: 'Café a granel',
          cost: 666.67,
          price: 999.99,
          quantity: 0.255,
          total: 254.99745,
          profit: 84.99915,
          margin: 33.333,
          price_mode: 'manual',
        },
      ],
      total: 254.99745,
      cost: 170.00085, // 666.67 * 0.255
      profit: 84.99915,
      margin: 33.3331,
    };

    const result = (await pipe.transform(payload, meta)) as CreateSaleDto;

    // No lanzó BadRequestException -> ya no rechaza por decimales.
    expect(result.items[0].profit).toBeCloseTo(85.0, 2);
    expect(result.items[0].total).toBeCloseTo(255.0, 2);
    // Redondeado a 2 decimales como máximo.
    expect(decimals(result.items[0].profit)).toBeLessThanOrEqual(2);
    expect(decimals(result.items[0].total)).toBeLessThanOrEqual(2);
    expect(decimals(result.cost)).toBeLessThanOrEqual(2);
    expect(decimals(result.profit)).toBeLessThanOrEqual(2);
  });
});

function decimals(n: number): number {
  const s = String(n);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}
