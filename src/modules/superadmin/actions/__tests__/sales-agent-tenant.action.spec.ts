import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { TelegramBotManager } from '@/modules/sales-agent/channels/telegram/telegram-bot.manager';

import {
  AI_USAGE_BY_COMPANY_SQL,
  PLACE_USAGE_KINDS,
  SALES_AGENT_USAGE_KINDS,
  buildAiUsageTotalsSql,
} from '../ai-usage.sql';
import type { GetAiUsageAction } from '../get-ai-usage.action';
import { SalesAgentTenantAction } from '../sales-agent-tenant.action';

const usageResult = {
  range: { from: '2026-10-01', to: '2026-10-30' },
  totals: {
    prompt_tokens: 1,
    output_tokens: 1,
    thoughts_tokens: 0,
    cached_tokens: 0,
    total_tokens: 2,
    questions: 0,
    greetings: 0,
    agent_messages: 3,
    agent_audios: 1,
    catalog_suggestions: 0,
  },
  daily: [],
  by_model: [],
};

const makeAction = (options: {
  company?: { sales_agent_enabled: boolean } | null;
  configs?: unknown[];
  settings?: unknown[];
}) => {
  const query = jest.fn(async (sql: string) => {
    if (sql.startsWith('SELECT sales_agent_enabled FROM companies')) {
      return options.company === null ? [] : [options.company ?? { sales_agent_enabled: false }];
    }
    if (sql.includes('FROM sales_bot_configs')) {
      return options.configs ?? [];
    }
    if (sql.includes('FROM sales_bot_settings')) {
      return options.settings ?? [];
    }
    return [];
  });
  const salesAgent = jest.fn().mockResolvedValue(usageResult);
  const refresh = jest.fn().mockResolvedValue(undefined);
  const action = new SalesAgentTenantAction(
    { query } as unknown as DataSource,
    { salesAgent } as unknown as GetAiUsageAction,
    { refresh } as unknown as TelegramBotManager,
  );
  return { action, query, salesAgent, refresh };
};

describe('SalesAgentTenantAction.get', () => {
  it('devuelve interruptor, nombre, canales (sin secretos) y consumo del agente', async () => {
    const h = makeAction({
      company: { sales_agent_enabled: true },
      configs: [
        {
          channel: 'telegram',
          enabled: true,
          has_token: true,
          telegram_bot_username: 'granero_bot',
        },
        { channel: 'whatsapp', enabled: false, has_token: false, telegram_bot_username: null },
      ],
      settings: [{ bot_name: ' Gysell ' }],
    });

    const result = await h.action.get(7, '2026-10-01', '2026-10-30');

    expect(h.salesAgent).toHaveBeenCalledWith(7, '2026-10-01', '2026-10-30');
    expect(result).toMatchObject({
      sales_agent_enabled: true,
      bot_name: 'Gysell',
      channels: {
        telegram: { configured: true, enabled: true, bot_username: 'granero_bot' },
        whatsapp: { configured: true, enabled: false },
      },
      totals: { agent_messages: 3 },
    });
    expect(JSON.stringify(result)).not.toMatch(/token":/);
  });

  it('sin configuración: canales sin configurar y apagados', async () => {
    const h = makeAction({ company: { sales_agent_enabled: false } });
    const result = await h.action.get(7);
    expect(result.channels).toEqual({
      telegram: { configured: false, enabled: false, bot_username: null },
      whatsapp: { configured: false, enabled: false },
    });
    expect(result.bot_name).toBe('');
  });

  it('company inexistente → 404', async () => {
    await expect(makeAction({ company: null }).action.get(7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SalesAgentTenantAction.setAccess', () => {
  it('guarda el flag de ESA company y re-sincroniza su bot de Telegram al instante', async () => {
    const h = makeAction({ company: { sales_agent_enabled: false } });
    await expect(h.action.setAccess(7, true)).resolves.toEqual({ salesAgentEnabled: true });
    expect(h.query).toHaveBeenCalledWith(
      'UPDATE companies SET sales_agent_enabled = $1 WHERE id = $2',
      [true, '7'],
    );
    expect(h.refresh).toHaveBeenCalledWith(7);
  });

  it('apagar también re-sincroniza (detiene el bot)', async () => {
    const h = makeAction({ company: { sales_agent_enabled: true } });
    await h.action.setAccess(7, false);
    expect(h.refresh).toHaveBeenCalledWith(7);
  });

  it('si el bot no se puede re-sincronizar, el cambio igual queda guardado', async () => {
    const h = makeAction({ company: { sales_agent_enabled: false } });
    h.refresh.mockRejectedValue(new Error('telegram caído'));
    await expect(h.action.setAccess(7, true)).resolves.toEqual({ salesAgentEnabled: true });
  });

  it('company inexistente → 404 sin escribir', async () => {
    const h = makeAction({ company: null });
    await expect(h.action.setAccess(7, true)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.query).not.toHaveBeenCalledWith(expect.stringMatching(/^UPDATE/), expect.anything());
  });
});

describe('Consumo de IA por tipo', () => {
  it('Place y el asistente de ventas se cuentan por separado', () => {
    expect([...PLACE_USAGE_KINDS]).toEqual(['chat', 'greeting']);
    expect([...SALES_AGENT_USAGE_KINDS]).toEqual([
      'sales_agent',
      'sales_agent_audio',
      'catalog_suggest',
    ]);
  });

  it('el filtro de tipos va en el último parámetro ($3 global, $4 con company)', () => {
    expect(buildAiUsageTotalsSql(false)).toContain('e.kind = ANY($3::text[])');
    expect(buildAiUsageTotalsSql(true)).toContain('e.company_id = $3');
    expect(buildAiUsageTotalsSql(true)).toContain('e.kind = ANY($4::text[])');
    expect(AI_USAGE_BY_COMPANY_SQL).toContain('e.kind = ANY($4::text[])');
  });

  it('cuenta mensajes, audios y fichas del agente', () => {
    const sql = buildAiUsageTotalsSql(true);
    expect(sql).toContain("e.kind = 'sales_agent')::int       AS agent_messages");
    expect(sql).toContain('AS agent_audios');
    expect(sql).toContain('AS catalog_suggestions');
  });
});
