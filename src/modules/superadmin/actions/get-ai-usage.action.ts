import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AiCreditsAction, creditsDay } from '@/modules/ai/actions/ai-credits.action';
import type { AiCreditsStatus } from '@/modules/ai/internal/ai-usage';
import { parseUtcRange } from '@/modules/reports/internal/range';
import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';

import {
  AI_ENABLED_COMPANIES_SQL,
  AI_USAGE_BY_COMPANY_SQL,
  buildAiUsageByModelSql,
  buildAiUsageDailySql,
  buildAiUsageTotalsSql,
} from './ai-usage.sql';

/** Totales de tokens y llamadas de un período. */
export interface AiUsageTotals {
  /** Entrada: prompt de sistema + historial + resultados de herramientas. */
  prompt_tokens: number;
  /** Salida visible de Gemini. */
  output_tokens: number;
  /** Razonamiento interno (se cobra como salida). */
  thoughts_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  /** Mensajes al chat (cada uno gastó un crédito). */
  questions: number;
  /** Saludos generados por Place. */
  greetings: number;
}

export interface AiUsageDay extends AiUsageTotals {
  day: string;
}

export interface AiUsageByModel extends AiUsageTotals {
  model: string;
}

export interface AiUsageByCompany extends AiUsageTotals {
  company_id: number;
  company_name: string;
  ai_enabled: boolean;
  ai_daily_credits: number;
  used_today: number;
}

export interface AiUsageRange {
  from: string;
  to: string;
}

export interface GlobalAiUsage {
  range: AiUsageRange;
  totals: AiUsageTotals;
  daily: AiUsageDay[];
  by_model: AiUsageByModel[];
  by_company: AiUsageByCompany[];
  companies: { enabled: number; enabled_without_credits: number };
}

export interface TenantAiUsage {
  range: AiUsageRange;
  ai_enabled: boolean;
  credits: AiCreditsStatus;
  totals: AiUsageTotals;
  daily: AiUsageDay[];
  by_model: AiUsageByModel[];
}

type Row = Record<string, unknown>;

const int = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export const toUsageTotals = (row: Row | undefined): AiUsageTotals => ({
  prompt_tokens: int(row?.prompt_tokens),
  output_tokens: int(row?.output_tokens),
  thoughts_tokens: int(row?.thoughts_tokens),
  cached_tokens: int(row?.cached_tokens),
  total_tokens: int(row?.total_tokens),
  questions: int(row?.questions),
  greetings: int(row?.greetings),
});

/** Últimos 30 días (Colombia) si el panel no manda rango. */
export const resolveUsageRange = (from?: string, to?: string): AiUsageRange => {
  const today = dayjs().tz(APP_TIMEZONE).format('YYYY-MM-DD');
  const end = to ?? today;
  const start = from ?? dayjs(end, 'YYYY-MM-DD').subtract(29, 'day').format('YYYY-MM-DD');
  return { from: start, to: end };
};

/**
 * Consumo de Place para el panel superadmin: global (todos los negocios) o de
 * un negocio con sus créditos del día. Solo lectura.
 */
@Injectable()
export class GetAiUsageAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly credits: AiCreditsAction,
  ) {}

  async global(from?: string, to?: string): Promise<GlobalAiUsage> {
    const range = resolveUsageRange(from, to);
    const { dateStart, dateEnd } = parseUtcRange(range.from, range.to);
    const params = [dateStart, dateEnd];
    const [totals, daily, by_model, by_company, companies] = await Promise.all([
      this.dataSource.query<Row[]>(buildAiUsageTotalsSql(false), params),
      this.dataSource.query<Row[]>(buildAiUsageDailySql(false), params),
      this.dataSource.query<Row[]>(buildAiUsageByModelSql(false), params),
      this.dataSource.query<Row[]>(AI_USAGE_BY_COMPANY_SQL, [...params, creditsDay()]),
      this.dataSource.query<Row[]>(AI_ENABLED_COMPANIES_SQL),
    ]);
    return {
      range,
      totals: toUsageTotals(totals[0]),
      daily: daily.map((row) => ({ day: String(row.day), ...toUsageTotals(row) })),
      by_model: by_model.map((row) => ({ model: String(row.model), ...toUsageTotals(row) })),
      by_company: by_company.map((row) => ({
        company_id: int(row.company_id),
        company_name: String(row.company_name ?? ''),
        ai_enabled: row.ai_enabled === true,
        ai_daily_credits: int(row.ai_daily_credits),
        used_today: int(row.used_today),
        ...toUsageTotals(row),
      })),
      companies: {
        enabled: int(companies[0]?.enabled),
        enabled_without_credits: int(companies[0]?.enabled_without_credits),
      },
    };
  }

  async tenant(company_id: number, from?: string, to?: string): Promise<TenantAiUsage> {
    const [company] = await this.dataSource.query<Array<{ ai_enabled: boolean }>>(
      'SELECT ai_enabled FROM companies WHERE id = $1',
      [String(company_id)],
    );
    if (!company) {
      throw new NotFoundException(`Company ${company_id} no existe.`);
    }
    const range = resolveUsageRange(from, to);
    const { dateStart, dateEnd } = parseUtcRange(range.from, range.to);
    const params = [dateStart, dateEnd, String(company_id)];
    const [totals, daily, by_model, credits] = await Promise.all([
      this.dataSource.query<Row[]>(buildAiUsageTotalsSql(true), params),
      this.dataSource.query<Row[]>(buildAiUsageDailySql(true), params),
      this.dataSource.query<Row[]>(buildAiUsageByModelSql(true), params),
      this.credits.status(company_id),
    ]);
    return {
      range,
      ai_enabled: company.ai_enabled === true,
      credits,
      totals: toUsageTotals(totals[0]),
      daily: daily.map((row) => ({ day: String(row.day), ...toUsageTotals(row) })),
      by_model: by_model.map((row) => ({ model: String(row.model), ...toUsageTotals(row) })),
    };
  }
}
