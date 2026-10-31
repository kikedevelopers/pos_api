import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { SalesBotSettingsService } from '../sales-bot-settings.service';
import type { SalesBotSettingsEntity } from '../entities/sales-bot-settings.entity';

const EXTRAS = {
  greeting_style: '',
  selling_style: '',
  closing_style: '',
  payment_methods: ['cash', 'bank_transfer'],
  payment_instructions: '',
  delivery_modes: ['pickup', 'delivery'],
  pickup_address: '',
  off_topic_limit: 3,
};
const DEFAULTS = {
  bot_name: '',
  personality: 'amable_profesional',
  stock_policy: 'inform',
  ...EXTRAS,
};

const makeService = (existing: Partial<SalesBotSettingsEntity> | null) => {
  const repo = {
    findOne: jest.fn().mockResolvedValue(existing),
    create: jest.fn((partial: Partial<SalesBotSettingsEntity>) => ({ ...partial })),
    save: jest.fn(async (entity: SalesBotSettingsEntity) => entity),
  };
  const service = new SalesBotSettingsService(
    repo as unknown as Repository<SalesBotSettingsEntity>,
  );
  return { service, repo };
};

describe('SalesBotSettingsService.get', () => {
  it('sin fila devuelve los defaults', async () => {
    const { service } = makeService(null);
    await expect(service.get(7)).resolves.toEqual(DEFAULTS);
  });

  it('devuelve la persona y la política guardadas', async () => {
    const { service } = makeService({
      bot_name: '  Diana ',
      personality: 'formal_corporativo',
      stock_policy: 'offer_always',
    });
    await expect(service.get(7)).resolves.toEqual({
      bot_name: 'Diana',
      personality: 'formal_corporativo',
      stock_policy: 'offer_always',
      ...EXTRAS,
    });
  });

  it('valores desconocidos en BD caen a los defaults', async () => {
    const { service } = makeService({
      stock_policy: 'raro' as never,
      personality: 'grosero' as never,
    });
    await expect(service.get(7)).resolves.toEqual(DEFAULTS);
  });
});

describe('SalesBotSettingsService.update', () => {
  it('crea la fila del negocio si no existe', async () => {
    const { service, repo } = makeService(null);
    const result = await service.update(7, {
      bot_name: 'Diana',
      personality: 'directo_comercial',
      stock_policy: 'offer_always',
    });
    expect(repo.create).toHaveBeenCalledWith({ company_id: '7' });
    expect(result).toEqual({
      bot_name: 'Diana',
      personality: 'directo_comercial',
      stock_policy: 'offer_always',
      ...EXTRAS,
    });
  });

  it('modifica la fila existente y recorta el nombre', async () => {
    const { service, repo } = makeService({ ...DEFAULTS, company_id: '7' } as never);
    const result = await service.update(7, { bot_name: '  Andrea  ' });
    expect(repo.create).not.toHaveBeenCalled();
    expect(result.bot_name).toBe('Andrea');
  });

  it('los campos omitidos conservan su valor (clientes viejos solo mandan stock_policy)', async () => {
    const { service } = makeService({
      bot_name: 'Diana',
      personality: 'formal_corporativo',
      stock_policy: 'inform',
    });
    const result = await service.update(7, { stock_policy: 'offer_always' });
    expect(result).toEqual({
      bot_name: 'Diana',
      personality: 'formal_corporativo',
      stock_policy: 'offer_always',
      ...EXTRAS,
    });
  });

  it('un nombre vacío vuelve al nombre por defecto', async () => {
    const { service } = makeService({ ...DEFAULTS, bot_name: 'Diana' } as never);
    const result = await service.update(7, { bot_name: '   ' });
    expect(result.bot_name).toBe('');
  });

  it('acepta un nombre de exactamente 60 caracteres', async () => {
    const { service } = makeService(null);
    const result = await service.update(7, { bot_name: 'a'.repeat(60) });
    expect(result.bot_name).toHaveLength(60);
  });

  it('rechaza un nombre de más de 60 caracteres sin guardar', async () => {
    const { service, repo } = makeService(null);
    await expect(service.update(7, { bot_name: 'a'.repeat(61) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rechaza una personalidad inválida sin guardar', async () => {
    const { service, repo } = makeService(null);
    await expect(service.update(7, { personality: 'grosero' as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rechaza una política inválida sin guardar', async () => {
    const { service, repo } = makeService(null);
    await expect(service.update(7, { stock_policy: 'nunca' as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('SalesBotSettingsService · estilo propio', () => {
  it('devuelve el estilo guardado, recortado', async () => {
    const { service } = makeService({
      greeting_style: '  Saluda con "¡Hola, vecino!" ',
      selling_style: 'Recomienda lo de la casa',
      closing_style: 'Recuerda el domicilio gratis',
    });
    const result = await service.get(7);
    expect(result.greeting_style).toBe('Saluda con "¡Hola, vecino!"');
    expect(result.selling_style).toBe('Recomienda lo de la casa');
    expect(result.closing_style).toBe('Recuerda el domicilio gratis');
  });

  it('guarda cada etapa colapsando espacios y saltos de línea', async () => {
    const { service, repo } = makeService(null);
    const result = await service.update(7, {
      greeting_style: '  Hola,\n\n  ¿qué receta   preparas? ',
      closing_style: 'Cierra con\tcalidez',
    });
    expect(result.greeting_style).toBe('Hola, ¿qué receta preparas?');
    expect(result.closing_style).toBe('Cierra con calidez');
    expect(result.selling_style).toBe('');
    expect(repo.save).toHaveBeenCalled();
  });

  it('las etapas omitidas conservan su valor', async () => {
    const { service } = makeService({ ...DEFAULTS, selling_style: 'Lo de la casa' } as never);
    const result = await service.update(7, { greeting_style: 'Hola vecino' });
    expect(result.selling_style).toBe('Lo de la casa');
    expect(result.greeting_style).toBe('Hola vecino');
  });

  it('un texto vacío borra la indicación (vuelve al preset)', async () => {
    const { service } = makeService({ ...DEFAULTS, closing_style: 'Algo' } as never);
    const result = await service.update(7, { closing_style: '   ' });
    expect(result.closing_style).toBe('');
  });

  it('acepta exactamente 500 caracteres', async () => {
    const { service } = makeService(null);
    const result = await service.update(7, { selling_style: 'a'.repeat(500) });
    expect(result.selling_style).toHaveLength(500);
  });

  it.each(['greeting_style', 'selling_style', 'closing_style'] as const)(
    'rechaza %s de más de 500 caracteres sin guardar',
    async (field) => {
      const { service, repo } = makeService(null);
      await expect(service.update(7, { [field]: 'a'.repeat(501) })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    },
  );
});

describe('SalesBotSettingsService · formas de pago', () => {
  it('sin fila: efectivo y transferencia (lo que ofrecía antes)', async () => {
    const { service } = makeService(null);
    const result = await service.get(7);
    expect(result.payment_methods).toEqual(['cash', 'bank_transfer']);
    expect(result.payment_instructions).toBe('');
  });

  it('guarda las formas elegidas en orden canónico y sin duplicados', async () => {
    const { service } = makeService(null);
    const result = await service.update(7, {
      payment_methods: ['credit_card', 'cash', 'credit_card', 'debit_card'],
    });
    expect(result.payment_methods).toEqual(['cash', 'debit_card', 'credit_card']);
  });

  it('acepta una sola forma de pago', async () => {
    const { service } = makeService(null);
    const result = await service.update(7, { payment_methods: ['bank_transfer'] });
    expect(result.payment_methods).toEqual(['bank_transfer']);
  });

  it('rechaza una lista vacía sin guardar', async () => {
    const { service, repo } = makeService(null);
    await expect(service.update(7, { payment_methods: [] })).rejects.toThrow(
      'Elige al menos una forma de pago.',
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rechaza una forma de pago desconocida sin guardar', async () => {
    const { service, repo } = makeService(null);
    await expect(
      service.update(7, { payment_methods: ['cash', 'bitcoin' as never] }),
    ).rejects.toThrow('Forma de pago no válida.');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('omitidas conservan las guardadas', async () => {
    const { service } = makeService({ ...DEFAULTS, payment_methods: ['debit_card'] } as never);
    const result = await service.update(7, { bot_name: 'Diana' });
    expect(result.payment_methods).toEqual(['debit_card']);
  });

  it('valores corruptos en BD caen al default', async () => {
    const { service } = makeService({ payment_methods: ['bitcoin'] as never });
    await expect(service.get(7)).resolves.toMatchObject({
      payment_methods: ['cash', 'bank_transfer'],
    });
  });

  it('guarda las indicaciones de pago normalizadas', async () => {
    const { service } = makeService(null);
    const result = await service.update(7, {
      payment_instructions: '  Nequi 300 123 4567\n Datáfono en domicilios ',
    });
    expect(result.payment_instructions).toBe('Nequi 300 123 4567 Datáfono en domicilios');
  });

  it('rechaza indicaciones de más de 300 caracteres sin guardar', async () => {
    const { service, repo } = makeService(null);
    await expect(
      service.update(7, { payment_instructions: 'a'.repeat(301) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('SalesBotSettingsService · entregas', () => {
  it('sin fila: recoger y domicilio', async () => {
    const { service } = makeService(null);
    const result = await service.get(7);
    expect(result.delivery_modes).toEqual(['pickup', 'delivery']);
    expect(result.pickup_address).toBe('');
  });

  it('guarda "solo recoger" y la dirección de recogida normalizada', async () => {
    const { service, repo } = makeService(null);
    const result = await service.update(7, {
      delivery_modes: ['pickup'],
      pickup_address: '  Calle 10 # 5-20\n local 3 ',
    });
    expect(result.delivery_modes).toEqual(['pickup']);
    expect(result.pickup_address).toBe('Calle 10 # 5-20 local 3');
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_modes: ['pickup'],
        pickup_address: 'Calle 10 # 5-20 local 3',
      }),
    );
  });

  it('orden canónico y sin duplicados', async () => {
    const { service } = makeService(null);
    const result = await service.update(7, { delivery_modes: ['delivery', 'pickup', 'delivery'] });
    expect(result.delivery_modes).toEqual(['pickup', 'delivery']);
  });

  it('rechaza una lista vacía sin guardar', async () => {
    const { service, repo } = makeService(null);
    await expect(service.update(7, { delivery_modes: [] })).rejects.toThrow(
      'Elige al menos una forma de entrega.',
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rechaza una forma de entrega desconocida sin guardar', async () => {
    const { service, repo } = makeService(null);
    await expect(
      service.update(7, { delivery_modes: ['pickup', 'drone' as never] }),
    ).rejects.toThrow('Forma de entrega no válida.');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rechaza una dirección de recogida de más de 250 caracteres', async () => {
    const { service, repo } = makeService(null);
    await expect(service.update(7, { pickup_address: 'a'.repeat(251) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('omitidas conservan las guardadas', async () => {
    const { service } = makeService({ ...DEFAULTS, delivery_modes: ['delivery'] } as never);
    const result = await service.update(7, { bot_name: 'Diana' });
    expect(result.delivery_modes).toEqual(['delivery']);
  });

  it('valores corruptos en BD caen al default', async () => {
    const { service } = makeService({ delivery_modes: ['drone'] as never });
    await expect(service.get(7)).resolves.toMatchObject({ delivery_modes: ['pickup', 'delivery'] });
  });
});

describe('SalesBotSettingsService · límite de mensajes fuera de tema', () => {
  it('default 3; guarda el límite elegido (0 = apagado)', async () => {
    expect((await makeService(null).service.get(7)).off_topic_limit).toBe(3);
    const { service } = makeService(null);
    expect((await service.update(7, { off_topic_limit: 0 })).off_topic_limit).toBe(0);
    expect((await service.update(7, { off_topic_limit: 5 })).off_topic_limit).toBe(5);
  });

  it('rechaza fuera de rango o no entero, sin guardar', async () => {
    for (const value of [-1, 11, 2.5]) {
      const { service, repo } = makeService(null);
      await expect(service.update(7, { off_topic_limit: value })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    }
  });

  it('valor corrupto en BD cae al default', async () => {
    const { service } = makeService({ off_topic_limit: 99 } as never);
    expect((await service.get(7)).off_topic_limit).toBe(3);
  });
});
