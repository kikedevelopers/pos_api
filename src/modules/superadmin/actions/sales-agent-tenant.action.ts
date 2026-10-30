import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TelegramBotManager } from '@/modules/sales-agent/channels/telegram/telegram-bot.manager';

import { GetAiUsageAction, type SalesAgentUsage } from './get-ai-usage.action';

/** Estado de un canal del agente, sin secretos. */
export interface SalesAgentChannelSummary {
  /** Hay configuración guardada (token / número). */
  configured: boolean;
  /** El dueño lo activó en su app (además del interruptor del panel). */
  enabled: boolean;
  /** Telegram: @usuario del bot. */
  bot_username?: string | null;
}

/** Asistente de ventas de un negocio, para el panel superadmin. */
export interface TenantSalesAgent extends SalesAgentUsage {
  sales_agent_enabled: boolean;
  /** Nombre con el que se presenta el agente ('' = por defecto). */
  bot_name: string;
  channels: {
    telegram: SalesAgentChannelSummary;
    whatsapp: SalesAgentChannelSummary;
  };
}

interface ConfigRow {
  channel: string;
  enabled: boolean;
  has_token: boolean;
  telegram_bot_username: string | null;
}

/**
 * Asistente de ventas de UN negocio desde el panel superadmin: estado,
 * canales, consumo de IA e interruptor. Cada company (principal o sucursal)
 * tiene el suyo. Apagarlo detiene el bot de Telegram al instante y bloquea
 * WhatsApp y la configuración (403 SALES_AGENT_NOT_ENABLED).
 */
@Injectable()
export class SalesAgentTenantAction {
  private readonly logger = new Logger(SalesAgentTenantAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly usage: GetAiUsageAction,
    private readonly telegramManager: TelegramBotManager,
  ) {}

  async get(companyId: number, from?: string, to?: string): Promise<TenantSalesAgent> {
    const enabled = await this.companyFlag(companyId);
    const [configs, settings, usage] = await Promise.all([
      this.dataSource.query<ConfigRow[]>(
        `SELECT channel, enabled,
                (telegram_token IS NOT NULL OR whatsapp_access_token IS NOT NULL
                  OR whatsapp_phone_number_id IS NOT NULL) AS has_token,
                telegram_bot_username
           FROM sales_bot_configs
          WHERE company_id = $1`,
        [String(companyId)],
      ),
      this.dataSource.query<Array<{ bot_name: string | null }>>(
        'SELECT bot_name FROM sales_bot_settings WHERE company_id = $1 LIMIT 1',
        [String(companyId)],
      ),
      this.usage.salesAgent(companyId, from, to),
    ]);
    const telegram = configs.find((c) => c.channel === 'telegram');
    const whatsapp = configs.find((c) => c.channel === 'whatsapp');
    return {
      sales_agent_enabled: enabled,
      bot_name: settings[0]?.bot_name?.trim() ?? '',
      channels: {
        telegram: {
          configured: telegram?.has_token === true,
          enabled: telegram?.enabled === true,
          bot_username: telegram?.telegram_bot_username ?? null,
        },
        // WhatsApp se conecta por QR en el escritorio: "configurado" = tiene fila.
        whatsapp: {
          configured: whatsapp !== undefined,
          enabled: whatsapp?.enabled === true,
        },
      },
      ...usage,
    };
  }

  async setAccess(companyId: number, enabled: boolean): Promise<{ salesAgentEnabled: boolean }> {
    await this.companyFlag(companyId);
    await this.dataSource.query('UPDATE companies SET sales_agent_enabled = $1 WHERE id = $2', [
      enabled,
      String(companyId),
    ]);
    // Aplica en caliente: detiene el bot de Telegram o lo arranca si quedó listo.
    try {
      await this.telegramManager.refresh(companyId);
    } catch (error) {
      this.logger.warn({ err: error, companyId }, 'No se pudo re-sincronizar el bot de Telegram');
    }
    this.logger.log({ event: 'superadmin.sales_agent_access.updated', companyId, enabled });
    return { salesAgentEnabled: enabled };
  }

  private async companyFlag(companyId: number): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ sales_agent_enabled: boolean }>>(
      'SELECT sales_agent_enabled FROM companies WHERE id = $1',
      [String(companyId)],
    );
    if (!rows[0]) {
      throw new NotFoundException(`Company ${companyId} no existe.`);
    }
    return rows[0].sales_agent_enabled === true;
  }
}
