import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { SalesBotConfig } from '@/config/sales-bot.config';

import { SalesAgentService } from '../../seller-agent.service';
import { SalesBotConfigService } from '../../sales-bot-config.service';
import { SellerSessionStore } from '../../internal/session-store';
import { TelegramBotWorker } from './telegram-bot.worker';

/**
 * Orquestador MULTI-TENANT de los bots de Telegram. Mantiene un
 * `TelegramBotWorker` vivo por cada negocio con bot configurado y activo.
 *
 * - Al arrancar la app: levanta un worker por cada config habilitada en BD
 *   (`sales_bot_configs`). Además, por compatibilidad, respeta el bot legacy por
 *   variables de entorno (`SALES_BOT_*`) SOLO si ese negocio no tiene ya una
 *   config en BD.
 * - Cuando el dueño cambia su config desde el menú, el controller llama a
 *   `refresh(companyId)`: se detiene el worker viejo y, si quedó activo y con
 *   token, se arranca uno nuevo con los datos frescos.
 *
 * El cerebro (`SalesAgentService`) es único y agnóstico del canal; aquí solo se
 * administran los loops de polling.
 */
@Injectable()
export class TelegramBotManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotManager.name);
  private readonly workers = new Map<number, TelegramBotWorker>();

  constructor(
    private readonly configService: ConfigService,
    private readonly agent: SalesAgentService,
    private readonly sessions: SellerSessionStore,
    private readonly botConfig: SalesBotConfigService,
  ) {}

  private get envConfig(): SalesBotConfig {
    return this.configService.getOrThrow<SalesBotConfig>('salesBot');
  }

  async onModuleInit(): Promise<void> {
    if (!this.agent.isReady()) {
      this.logger.warn('IA (Gemini) no configurada; los bots de Telegram no arrancan.');
      return;
    }

    // 1) Bots configurados por los dueños en la BD.
    let dbCompanyIds: Set<number>;
    try {
      const configs = await this.botConfig.listRunnableTelegram();
      dbCompanyIds = new Set(configs.map((c) => Number(c.company_id)));
      for (const config of configs) {
        this.startWorker({
          companyId: Number(config.company_id),
          token: config.telegram_token ?? '',
          ownerChatId: config.owner_chat_id,
        });
      }
      this.logger.log({ count: configs.length }, 'Bots de Telegram activos desde BD.');
    } catch (error) {
      this.logger.error({ err: error }, 'No pude cargar las configs de bots desde BD.');
      dbCompanyIds = new Set();
    }

    // 2) Bot legacy por env — solo si ese negocio no está ya en BD.
    const env = this.envConfig;
    if (env.enabled && env.telegram.token && env.companyId && !dbCompanyIds.has(env.companyId)) {
      this.startWorker({
        companyId: env.companyId,
        token: env.telegram.token,
        ownerChatId: env.telegram.ownerChatId || null,
      });
      this.logger.log({ companyId: env.companyId }, 'Bot de Telegram legacy (env) activo.');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.stop()));
    this.workers.clear();
  }

  /**
   * Re-sincroniza el bot de UN negocio tras cambiar su config. Detiene el worker
   * actual (si lo hay) y arranca uno nuevo si quedó activo, con token y la IA
   * lista. Seguro de llamar siempre: si no procede, solo detiene.
   */
  async refresh(companyId: number): Promise<void> {
    await this.stopWorker(companyId);

    if (!this.agent.isReady()) return;

    const config = await this.botConfig.getTelegramEntity(companyId);
    if (!config || !config.enabled || !config.telegram_token) return;

    this.startWorker({
      companyId,
      token: config.telegram_token,
      ownerChatId: config.owner_chat_id,
    });
    this.logger.log({ companyId }, 'Bot de Telegram del negocio re-sincronizado (activo).');
  }

  private startWorker(args: {
    companyId: number;
    token: string;
    ownerChatId: string | null;
  }): void {
    if (this.workers.has(args.companyId)) return;
    const env = this.envConfig;
    const worker = new TelegramBotWorker({
      companyId: args.companyId,
      token: args.token,
      ownerChatId: args.ownerChatId,
      pollIntervalMs: env.telegram.pollIntervalMs,
      longPollTimeoutSec: env.telegram.longPollTimeoutSec,
      agent: this.agent,
      sessions: this.sessions,
    });
    this.workers.set(args.companyId, worker);
    worker.start();
  }

  private async stopWorker(companyId: number): Promise<void> {
    const worker = this.workers.get(companyId);
    if (!worker) return;
    this.workers.delete(companyId);
    await worker.stop();
  }
}
