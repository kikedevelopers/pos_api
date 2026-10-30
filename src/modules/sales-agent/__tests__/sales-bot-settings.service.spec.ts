import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { SalesBotSettingsService } from '../sales-bot-settings.service';
import type { SalesBotSettingsEntity } from '../entities/sales-bot-settings.entity';

const DEFAULTS = { bot_name: '', personality: 'amable_profesional', stock_policy: 'inform' };

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
