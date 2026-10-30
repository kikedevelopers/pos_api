import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { SalesBotConfigService } from '../sales-bot-config.service';
import { SalesBotConfigEntity } from '../entities/sales-bot-config.entity';

const okJson = (body: unknown): Response => ({ json: async () => body }) as unknown as Response;

/** getMe válido con la identidad del bot. */
const mockGetMeOk = (username = 'mi_bot'): void => {
  jest.spyOn(global, 'fetch').mockResolvedValue(
    okJson({ ok: true, result: { id: 123456, username, first_name: 'Andrea' } }),
  );
};

/** Telegram rechaza el token (401). */
const mockGetMeInvalid = (): void => {
  jest.spyOn(global, 'fetch').mockResolvedValue(
    okJson({ ok: false, error_code: 401, description: 'Unauthorized' }),
  );
};

interface Harness {
  service: SalesBotConfigService;
  repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
}

const makeService = (existing: Partial<SalesBotConfigEntity> | null = null): Harness => {
  const repo = {
    findOne: jest.fn().mockResolvedValue(existing),
    // create devuelve una entidad con los campos base mezclados.
    create: jest.fn((partial: Partial<SalesBotConfigEntity>) => ({ ...partial })),
    // save devuelve lo que recibe más un updated_at para el DTO público.
    save: jest.fn(async (entity: SalesBotConfigEntity) => ({
      ...entity,
      updated_at: new Date('2026-10-29T12:00:00Z'),
    })),
    createQueryBuilder: jest.fn(),
  };
  const service = new SalesBotConfigService(repo as unknown as Repository<SalesBotConfigEntity>);
  return { service, repo };
};

afterEach(() => jest.restoreAllMocks());

describe('SalesBotConfigService.upsertTelegram', () => {
  it('rechaza una personalidad no válida', async () => {
    const { service } = makeService();
    await expect(
      service.upsertTelegram(7, {
        bot_name: 'Andrea',
        personality: 'payaso' as never,
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un nombre de más de 60 caracteres', async () => {
    const { service } = makeService();
    await expect(
      service.upsertTelegram(7, {
        bot_name: 'a'.repeat(61),
        personality: 'amable_profesional',
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('valida el token nuevo con getMe y guarda la identidad del bot', async () => {
    mockGetMeOk('granero_bot');
    const { service, repo } = makeService();

    const result = await service.upsertTelegram(7, {
      bot_name: 'Andrea',
      personality: 'directo_comercial',
      enabled: true,
      token: '123:ABC',
    });

    const saved = repo.save.mock.calls[0][0] as SalesBotConfigEntity;
    expect(saved.telegram_token).toBe('123:ABC');
    expect(saved.telegram_bot_username).toBe('granero_bot');
    expect(saved.telegram_bot_id).toBe('123456');
    expect(saved.enabled).toBe(true);
    // El DTO público nunca expone el token.
    expect(result).not.toHaveProperty('telegram_token');
    expect(result.has_token).toBe(true);
    expect(result.bot_username).toBe('granero_bot');
  });

  it('rechaza un token inválido (getMe falla) y no guarda', async () => {
    mockGetMeInvalid();
    const { service, repo } = makeService();

    await expect(
      service.upsertTelegram(7, {
        bot_name: 'Andrea',
        personality: 'amable_profesional',
        enabled: true,
        token: 'token-malo',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('no deja ACTIVAR el bot sin token guardado', async () => {
    const { service, repo } = makeService(null);
    await expect(
      service.upsertTelegram(7, {
        bot_name: 'Andrea',
        personality: 'amable_profesional',
        enabled: true,
        // sin token y sin config previa
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('conserva el token guardado cuando no se reenvía (token vacío)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const { service, repo } = makeService({
      company_id: '7',
      channel: 'telegram',
      telegram_token: 'token-viejo',
      telegram_bot_username: 'viejo_bot',
      telegram_bot_id: '999',
      enabled: true,
    } as Partial<SalesBotConfigEntity>);

    const result = await service.upsertTelegram(7, {
      bot_name: 'Nuevo nombre',
      personality: 'formal_corporativo',
      enabled: true,
      token: '',
    });

    // No se llamó a Telegram porque no cambió el token.
    expect(fetchSpy).not.toHaveBeenCalled();
    const saved = repo.save.mock.calls[0][0] as SalesBotConfigEntity;
    expect(saved.telegram_token).toBe('token-viejo');
    expect(saved.bot_name).toBe('Nuevo nombre');
    expect(saved.personality).toBe('formal_corporativo');
    expect(result.has_token).toBe(true);
  });

  it('recorta el nombre y normaliza owner_chat_id vacío a null', async () => {
    const { service, repo } = makeService({
      company_id: '7',
      channel: 'telegram',
      telegram_token: 't',
      enabled: false,
    } as Partial<SalesBotConfigEntity>);

    await service.upsertTelegram(7, {
      bot_name: '  Andrea  ',
      personality: 'amable_profesional',
      enabled: false,
      owner_chat_id: '   ',
    });

    const saved = repo.save.mock.calls[0][0] as SalesBotConfigEntity;
    expect(saved.bot_name).toBe('Andrea');
    expect(saved.owner_chat_id).toBeNull();
  });
});

describe('SalesBotConfigService.getPublicConfig', () => {
  it('devuelve defaults seguros cuando el negocio no tiene config', async () => {
    const { service } = makeService(null);
    const config = await service.getPublicConfig(7);
    expect(config).toEqual({
      channel: 'telegram',
      enabled: false,
      bot_name: '',
      personality: 'amable_profesional',
      has_token: false,
      bot_username: null,
      owner_chat_id: null,
      updated_at: null,
    });
  });

  it('marca has_token sin exponer el token', async () => {
    const { service } = makeService({
      telegram_token: 'secreto',
      telegram_bot_username: 'mi_bot',
      bot_name: 'Andrea',
      personality: 'directo_comercial',
      enabled: true,
      updated_at: new Date('2026-10-29T12:00:00Z'),
    } as Partial<SalesBotConfigEntity>);
    const config = await service.getPublicConfig(7);
    expect(config.has_token).toBe(true);
    expect(config).not.toHaveProperty('telegram_token');
    expect(config.bot_username).toBe('mi_bot');
  });
});

describe('SalesBotConfigService.getPersona', () => {
  it('defaults cuando no hay config', async () => {
    const { service } = makeService(null);
    await expect(service.getPersona(7)).resolves.toEqual({
      botName: '',
      personality: 'amable_profesional',
    });
  });

  it('entrega nombre y personalidad guardados', async () => {
    const { service } = makeService({
      bot_name: '  Andrea ',
      personality: 'formal_corporativo',
    } as Partial<SalesBotConfigEntity>);
    await expect(service.getPersona(7)).resolves.toEqual({
      botName: 'Andrea',
      personality: 'formal_corporativo',
    });
  });
});

describe('SalesBotConfigService.validateToken', () => {
  it('token válido → valid=true con username', async () => {
    mockGetMeOk('granero_bot');
    const { service } = makeService();
    await expect(service.validateToken('123:ABC')).resolves.toEqual({
      valid: true,
      bot_username: 'granero_bot',
      bot_name: 'Andrea',
    });
  });

  it('token inválido → valid=false sin lanzar', async () => {
    mockGetMeInvalid();
    const { service } = makeService();
    await expect(service.validateToken('malo')).resolves.toEqual({
      valid: false,
      bot_username: null,
      bot_name: null,
    });
  });
});

/* -------------------------------- WhatsApp -------------------------------- */

/** Repo cuyo findOne responde según el canal pedido en `where`. */
const makeServiceByChannel = (
  rows: Partial<Record<'telegram' | 'whatsapp', Partial<SalesBotConfigEntity> | null>>,
): { service: SalesBotConfigService; repo: Harness['repo'] } => {
  const repo = {
    findOne: jest.fn(async ({ where }: { where: { channel?: string } }) => {
      const channel = where?.channel as 'telegram' | 'whatsapp' | undefined;
      return (channel && rows[channel]) ?? null;
    }),
    create: jest.fn((partial: Partial<SalesBotConfigEntity>) => ({ ...partial })),
    save: jest.fn(async (entity: SalesBotConfigEntity) => ({
      ...entity,
      updated_at: new Date('2026-10-29T12:00:00Z'),
    })),
    createQueryBuilder: jest.fn(),
  };
  const service = new SalesBotConfigService(repo as unknown as Repository<SalesBotConfigEntity>);
  return { service, repo };
};

describe('SalesBotConfigService.upsertWhatsapp', () => {
  it('no deja ACTIVAR sin phone_number_id', async () => {
    const { service, repo } = makeServiceByChannel({ whatsapp: null });
    await expect(
      service.upsertWhatsapp(7, {
        bot_name: 'Andrea',
        personality: 'amable_profesional',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('guarda phone_number_id y token propio; el público no expone el token', async () => {
    const { service, repo } = makeServiceByChannel({ whatsapp: null });
    const result = await service.upsertWhatsapp(7, {
      bot_name: 'Andrea',
      personality: 'directo_comercial',
      enabled: true,
      phone_number_id: '111222',
      token: 'EAAG-secret',
      waba_id: 'waba-9',
    });
    const saved = repo.save.mock.calls[0][0] as SalesBotConfigEntity;
    expect(saved.whatsapp_phone_number_id).toBe('111222');
    expect(saved.whatsapp_access_token).toBe('EAAG-secret');
    expect(saved.channel).toBe('whatsapp');
    expect(result).not.toHaveProperty('whatsapp_access_token');
    expect(result.has_token).toBe(true);
    expect(result.phone_number_id).toBe('111222');
  });

  it('conserva el token propio cuando no se reenvía', async () => {
    const { service, repo } = makeServiceByChannel({
      whatsapp: {
        channel: 'whatsapp',
        whatsapp_phone_number_id: '111',
        whatsapp_access_token: 'viejo',
        enabled: true,
      } as Partial<SalesBotConfigEntity>,
    });
    await service.upsertWhatsapp(7, {
      bot_name: 'Andrea',
      personality: 'amable_profesional',
      enabled: true,
      phone_number_id: '111',
      token: '',
    });
    const saved = repo.save.mock.calls[0][0] as SalesBotConfigEntity;
    expect(saved.whatsapp_access_token).toBe('viejo');
  });

  it('traduce la violación de unicidad del phone_number_id a 400 amable', async () => {
    const { service, repo } = makeServiceByChannel({ whatsapp: null });
    repo.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(
      service.upsertWhatsapp(7, {
        bot_name: 'Andrea',
        personality: 'amable_profesional',
        enabled: false,
        phone_number_id: '111',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SalesBotConfigService.getWhatsappPublicConfig', () => {
  it('defaults seguros cuando no hay config', async () => {
    const { service } = makeServiceByChannel({ whatsapp: null });
    await expect(service.getWhatsappPublicConfig(7)).resolves.toEqual({
      channel: 'whatsapp',
      enabled: false,
      bot_name: '',
      personality: 'amable_profesional',
      has_token: false,
      phone_number_id: null,
      waba_id: null,
      owner_chat_id: null,
      updated_at: null,
    });
  });
});

describe('SalesBotConfigService.getPersona por canal', () => {
  it('usa la fila de WhatsApp cuando tiene nombre', async () => {
    const { service } = makeServiceByChannel({
      whatsapp: { bot_name: 'Gysell', personality: 'formal_corporativo' } as Partial<SalesBotConfigEntity>,
    });
    await expect(service.getPersona(7, 'whatsapp')).resolves.toEqual({
      botName: 'Gysell',
      personality: 'formal_corporativo',
    });
  });

  it('cae al nombre de Telegram si la fila de WhatsApp no tiene nombre', async () => {
    const { service } = makeServiceByChannel({
      whatsapp: { bot_name: '   ', personality: 'directo_comercial' } as Partial<SalesBotConfigEntity>,
      telegram: { bot_name: 'Andrea', personality: 'amable_profesional' } as Partial<SalesBotConfigEntity>,
    });
    const persona = await service.getPersona(7, 'whatsapp');
    expect(persona.botName).toBe('Andrea');
    // La personalidad se respeta de la fila de WhatsApp (que sí existe).
    expect(persona.personality).toBe('directo_comercial');
  });
});
