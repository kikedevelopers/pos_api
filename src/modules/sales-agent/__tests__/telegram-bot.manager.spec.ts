import type { ConfigService } from '@nestjs/config';

import type { SalesBotConfig } from '@/config/sales-bot.config';

import { TelegramBotManager } from '../channels/telegram/telegram-bot.manager';
import { TelegramBotWorker } from '../channels/telegram/telegram-bot.worker';
import type { SalesAgentService } from '../seller-agent.service';
import type { SalesBotConfigService } from '../sales-bot-config.service';
import type { SellerSessionStore } from '../internal/session-store';
import type { SalesBotConfigEntity } from '../entities/sales-bot-config.entity';
import type { SalesBotTakeoverService } from '../sales-bot-takeover.service';
import type { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';

const envConfig = (overrides: Partial<SalesBotConfig> = {}): SalesBotConfig => ({
  enabled: false,
  companyId: null,
  model: '',
  temperature: 0.8,
  maxOutputTokens: 2048,
  maxToolRounds: 4,
  thinkingBudget: 128,
  telegram: {
    token: '',
    pollIntervalMs: 1500,
    longPollTimeoutSec: 30,
    ownerChatId: '',
  },
  ...overrides,
});

const dbConfig = (companyId: number, token = 'tkn'): SalesBotConfigEntity =>
  ({
    company_id: String(companyId),
    channel: 'telegram',
    enabled: true,
    telegram_token: token,
    owner_chat_id: null,
  }) as SalesBotConfigEntity;

interface Harness {
  manager: TelegramBotManager;
  startSpy: jest.SpyInstance;
  stopSpy: jest.SpyInstance;
  listRunnable: jest.Mock;
  getEntity: jest.Mock;
  isReady: jest.Mock;
  enabledIds: jest.Mock;
  isEnabled: jest.Mock;
}

const makeManager = (env: SalesBotConfig): Harness => {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(env),
  } as unknown as ConfigService;

  const isReady = jest.fn().mockReturnValue(true);
  const agent = { isReady } as unknown as SalesAgentService;
  const sessions = {} as unknown as SellerSessionStore;

  const listRunnable = jest.fn().mockResolvedValue([]);
  const getEntity = jest.fn().mockResolvedValue(null);
  const botConfig = {
    listRunnableTelegram: listRunnable,
    getTelegramEntity: getEntity,
  } as unknown as SalesBotConfigService;

  // Los workers no deben tocar la red en el test.
  const startSpy = jest.spyOn(TelegramBotWorker.prototype, 'start').mockImplementation(() => {});
  const stopSpy = jest.spyOn(TelegramBotWorker.prototype, 'stop').mockResolvedValue(undefined);

  const takeovers = {} as unknown as SalesBotTakeoverService;

  // Por defecto todos los negocios de los tests tienen el agente habilitado.
  const enabledIds = jest.fn().mockResolvedValue([5, 7, 8, 99]);
  const isEnabled = jest.fn().mockResolvedValue(true);
  const access = {
    enabledCompanyIds: enabledIds,
    isEnabled,
  } as unknown as SalesAgentAccessService;

  const manager = new TelegramBotManager(
    configService,
    agent,
    sessions,
    botConfig,
    takeovers,
    access,
  );
  return { manager, startSpy, stopSpy, listRunnable, getEntity, isReady, enabledIds, isEnabled };
};

afterEach(() => jest.restoreAllMocks());

describe('TelegramBotManager.onModuleInit', () => {
  it('no arranca nada si la IA no está lista', async () => {
    const h = makeManager(envConfig());
    h.isReady.mockReturnValue(false);
    await h.manager.onModuleInit();
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it('arranca un worker por cada config habilitada en BD', async () => {
    const h = makeManager(envConfig());
    h.listRunnable.mockResolvedValue([dbConfig(7), dbConfig(8)]);
    await h.manager.onModuleInit();
    expect(h.startSpy).toHaveBeenCalledTimes(2);
  });

  it('arranca el bot legacy por env si su negocio NO está en BD', async () => {
    const h = makeManager(
      envConfig({
        enabled: true,
        companyId: 99,
        telegram: {
          token: 'env-tkn',
          pollIntervalMs: 1500,
          longPollTimeoutSec: 30,
          ownerChatId: '',
        },
      }),
    );
    h.listRunnable.mockResolvedValue([dbConfig(7)]);
    await h.manager.onModuleInit();
    // 1 de BD + 1 de env (negocio 99 no está en BD).
    expect(h.startSpy).toHaveBeenCalledTimes(2);
  });

  it('NO duplica el bot legacy por env si el negocio ya está en BD', async () => {
    const h = makeManager(
      envConfig({
        enabled: true,
        companyId: 7,
        telegram: {
          token: 'env-tkn',
          pollIntervalMs: 1500,
          longPollTimeoutSec: 30,
          ownerChatId: '',
        },
      }),
    );
    h.listRunnable.mockResolvedValue([dbConfig(7)]);
    await h.manager.onModuleInit();
    expect(h.startSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramBotManager.refresh', () => {
  it('detiene el worker y no lo rearranca si la config quedó deshabilitada', async () => {
    const h = makeManager(envConfig());
    h.listRunnable.mockResolvedValue([dbConfig(7)]);
    await h.manager.onModuleInit();
    h.startSpy.mockClear();

    h.getEntity.mockResolvedValue({ ...dbConfig(7), enabled: false });
    await h.manager.refresh(7);

    expect(h.stopSpy).toHaveBeenCalledTimes(1);
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it('arranca el worker cuando la config quedó activa y con token', async () => {
    const h = makeManager(envConfig());
    await h.manager.onModuleInit();
    h.startSpy.mockClear();

    h.getEntity.mockResolvedValue(dbConfig(5));
    await h.manager.refresh(5);

    expect(h.startSpy).toHaveBeenCalledTimes(1);
  });

  it('no arranca si la IA no está lista (solo detiene)', async () => {
    const h = makeManager(envConfig());
    await h.manager.onModuleInit();
    h.isReady.mockReturnValue(false);
    h.startSpy.mockClear();

    h.getEntity.mockResolvedValue(dbConfig(5));
    await h.manager.refresh(5);

    expect(h.startSpy).not.toHaveBeenCalled();
  });
});

describe('TelegramBotManager — agente inhabilitado desde el panel', () => {
  it('al arrancar no levanta bots de negocios con el agente inhabilitado', async () => {
    const h = makeManager(envConfig());
    h.enabledIds.mockResolvedValue([7]);
    h.listRunnable.mockResolvedValue([dbConfig(7), dbConfig(8)]);
    await h.manager.onModuleInit();
    expect(h.startSpy).toHaveBeenCalledTimes(1);
  });

  it('tampoco levanta el bot legacy por env si su negocio está inhabilitado', async () => {
    const h = makeManager(
      envConfig({
        enabled: true,
        companyId: 99,
        telegram: {
          token: 'env-tkn',
          pollIntervalMs: 1500,
          longPollTimeoutSec: 30,
          ownerChatId: '',
        },
      }),
    );
    h.enabledIds.mockResolvedValue([]);
    await h.manager.onModuleInit();
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it('refresh con el agente inhabilitado detiene el bot y no lo rearranca', async () => {
    const h = makeManager(envConfig());
    h.listRunnable.mockResolvedValue([dbConfig(7)]);
    await h.manager.onModuleInit();
    h.startSpy.mockClear();

    h.isEnabled.mockResolvedValue(false);
    h.getEntity.mockResolvedValue(dbConfig(7));
    await h.manager.refresh(7);

    expect(h.stopSpy).toHaveBeenCalledTimes(1);
    expect(h.startSpy).not.toHaveBeenCalled();
    expect(h.getEntity).not.toHaveBeenCalled();
  });
});
