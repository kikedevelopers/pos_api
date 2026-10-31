import type { ConfigService } from '@nestjs/config';

import type { WhatsappConfig } from '@/config/whatsapp.config';

import { WhatsappHandlerService } from '../channels/whatsapp/whatsapp-handler.service';
import { WhatsappClient } from '../channels/whatsapp/whatsapp.client';
import type { WhatsappIncomingMessage } from '../channels/whatsapp/whatsapp-webhook.parser';
import type { SalesAgentService } from '../seller-agent.service';
import type { SalesBotConfigService } from '../sales-bot-config.service';
import { SellerSessionStore } from '../internal/session-store';
import type { SalesBotConfigEntity } from '../entities/sales-bot-config.entity';
import type { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';

const waConfig: WhatsappConfig = {
  appSecret: 'secret',
  verifyToken: 'verify',
  accessToken: 'shared-token',
  graphApiVersion: 'v21.0',
};

const message = (overrides?: Partial<WhatsappIncomingMessage>): WhatsappIncomingMessage => ({
  phoneNumberId: '111',
  from: '573001112233',
  text: 'Hola, ¿tienes arroz?',
  senderName: 'María',
  messageId: 'wamid.1',
  ...overrides,
});

const tenant = (overrides?: Partial<SalesBotConfigEntity>): SalesBotConfigEntity =>
  ({
    company_id: '7',
    channel: 'whatsapp',
    enabled: true,
    whatsapp_phone_number_id: '111',
    whatsapp_access_token: null,
    owner_chat_id: null,
    ...overrides,
  }) as SalesBotConfigEntity;

interface Harness {
  handler: WhatsappHandlerService;
  handleMessage: jest.Mock;
  findTenant: jest.Mock;
  sendText: jest.SpyInstance;
  sessionReset: jest.Mock;
  isEnabled: jest.Mock;
}

const makeHandler = (tenantRow: SalesBotConfigEntity | null): Harness => {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(waConfig),
  } as unknown as ConfigService;

  const handleMessage = jest
    .fn()
    .mockResolvedValue({ reply: 'Claro, ¿cuánto llevas?', orders: [] });
  const agent = {
    isReady: jest.fn().mockReturnValue(true),
    handleMessage,
    greeting: jest
      .fn()
      .mockResolvedValue('Buenos días, soy Diana de Granero La 21. ¿Qué necesitas?'),
  } as unknown as SalesAgentService;

  const sessionReset = jest.fn();
  const sessions = {
    append: jest.fn((_key: string, turn: unknown) => [turn]),
    reset: sessionReset,
    markDay: jest.fn().mockReturnValue(true),
    rememberOrder: jest.fn().mockReturnValue(true),
    pruneExpired: jest.fn(),
  } as unknown as SellerSessionStore;

  const findTenant = jest.fn().mockResolvedValue(tenantRow);
  const botConfig = {
    findActiveWhatsappByPhoneNumberId: findTenant,
  } as unknown as SalesBotConfigService;

  const sendText = jest.spyOn(WhatsappClient.prototype, 'sendText').mockResolvedValue(true);
  jest.spyOn(WhatsappClient.prototype, 'markRead').mockResolvedValue(undefined);

  const isEnabled = jest.fn().mockResolvedValue(true);
  const access = { isEnabled } as unknown as SalesAgentAccessService;

  const handler = new WhatsappHandlerService(configService, agent, sessions, botConfig, access);
  return { handler, handleMessage, findTenant, sendText, sessionReset, isEnabled };
};

afterEach(() => jest.restoreAllMocks());

describe('WhatsappHandlerService.process', () => {
  it('con el agente inhabilitado desde el panel no responde ni llama a la IA', async () => {
    const h = makeHandler(tenant());
    h.isEnabled.mockResolvedValue(false);
    await h.handler.process([message()]);
    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('ignora un mensaje cuyo número no pertenece a ningún negocio activo', async () => {
    const h = makeHandler(null);
    await h.handler.process([message()]);
    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('rutea al negocio y responde con el texto del vendedor', async () => {
    const h = makeHandler(tenant());
    await h.handler.process([message()]);

    expect(h.handleMessage).toHaveBeenCalledTimes(1);
    const [ctx] = h.handleMessage.mock.calls[0];
    expect(ctx).toMatchObject({ companyId: 7, channel: 'whatsapp', chatId: '573001112233' });

    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: '111',
        to: '573001112233',
        text: 'Claro, ¿cuánto llevas?',
        token: 'shared-token',
      }),
    );
  });

  it('usa el token propio del negocio si lo tiene', async () => {
    const h = makeHandler(tenant({ whatsapp_access_token: 'propio-token' }));
    await h.handler.process([message()]);
    expect(h.sendText).toHaveBeenCalledWith(expect.objectContaining({ token: 'propio-token' }));
  });

  it('no reprocesa una reentrega con el mismo messageId', async () => {
    const h = makeHandler(tenant());
    await h.handler.process([message()]);
    await h.handler.process([message()]); // misma id
    expect(h.handleMessage).toHaveBeenCalledTimes(1);
  });

  it('un comando de reinicio resetea la sesión y envía el saludo del bot, sin IA', async () => {
    const h = makeHandler(tenant());
    await h.handler.process([message({ text: '/start', messageId: 'wamid.reset' })]);
    expect(h.sessionReset).toHaveBeenCalledTimes(1);
    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Buenos días, soy Diana de Granero La 21. ¿Qué necesitas?',
      }),
    );
  });

  it('pasa al agente la marca de primer mensaje del día', async () => {
    const h = makeHandler(tenant());
    await h.handler.process([message()]);
    expect(h.handleMessage.mock.calls[0][2]).toEqual({ firstMessageOfDay: true });
  });

  it('no responde si no hay token (ni propio ni compartido)', async () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue({ ...waConfig, accessToken: '' }),
    } as unknown as ConfigService;
    const handleMessage = jest.fn();
    const agent = { isReady: () => true, handleMessage } as unknown as SalesAgentService;
    const sessions = {
      append: jest.fn(),
      reset: jest.fn(),
      rememberOrder: jest.fn(),
      pruneExpired: jest.fn(),
    } as unknown as SellerSessionStore;
    const botConfig = {
      findActiveWhatsappByPhoneNumberId: jest.fn().mockResolvedValue(tenant()),
    } as unknown as SalesBotConfigService;
    const sendText = jest.spyOn(WhatsappClient.prototype, 'sendText').mockResolvedValue(true);
    jest.spyOn(WhatsappClient.prototype, 'markRead').mockResolvedValue(undefined);

    const access = {
      isEnabled: jest.fn().mockResolvedValue(true),
    } as unknown as SalesAgentAccessService;
    const handler = new WhatsappHandlerService(configService, agent, sessions, botConfig, access);
    await handler.process([message()]);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});
