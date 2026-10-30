import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { AiUsageKind } from '@/modules/ai/actions/ai-credits.action';
import { INSERT_USAGE_EVENT_SQL } from '@/modules/ai/internal/ai-credits-sql';
import type { GeminiUsage } from '@/modules/ai/internal/gemini.types';

/** Código del 403 cuando el agente no está habilitado para el negocio. */
export const SALES_AGENT_NOT_ENABLED = 'SALES_AGENT_NOT_ENABLED';

/** Consumo del asistente de ventas que se registra por cuenta. */
export type SalesAgentUsageKind = Extract<
  AiUsageKind,
  'sales_agent' | 'sales_agent_audio' | 'catalog_suggest'
>;

/**
 * Acceso al asistente de ventas de un negocio (`companies.sales_agent_enabled`)
 * y registro de su consumo de IA, que suma a la cuenta. Cada company (principal
 * o sucursal) tiene su propio interruptor; se enciende desde el panel superadmin.
 */
@Injectable()
export class SalesAgentAccessService {
  private readonly logger = new Logger(SalesAgentAccessService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** `true` si el negocio tiene el agente habilitado. Ante cualquier duda, `false`. */
  async isEnabled(companyId: number): Promise<boolean> {
    if (!Number.isSafeInteger(companyId) || companyId <= 0) {
      return false;
    }
    const rows = await this.dataSource.query<Array<{ sales_agent_enabled: boolean }>>(
      'SELECT sales_agent_enabled FROM companies WHERE id = $1 LIMIT 1',
      [String(companyId)],
    );
    return rows[0]?.sales_agent_enabled === true;
  }

  /** Lanza 403 (SALES_AGENT_NOT_ENABLED) si el negocio no tiene el agente. */
  async assertEnabled(companyId: number): Promise<void> {
    if (await this.isEnabled(companyId)) {
      return;
    }
    throw new ForbiddenException({
      message: 'El asistente de ventas no está habilitado para tu negocio.',
      payload: { code: SALES_AGENT_NOT_ENABLED },
    });
  }

  /** Ids de los negocios con el agente habilitado (para procesos de fondo). */
  async enabledCompanyIds(): Promise<number[]> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      'SELECT id FROM companies WHERE sales_agent_enabled = true ORDER BY id',
    );
    return rows.map((row) => Number(row.id));
  }

  /** Registra los tokens de una llamada del agente (nunca lanza). */
  async recordUsage(event: {
    companyId: number;
    kind: SalesAgentUsageKind;
    model: string;
    usage: GeminiUsage | undefined;
    rounds: number;
  }): Promise<void> {
    const usage = event.usage;
    if (!usage || (usage.total_tokens === 0 && event.rounds === 0)) {
      return;
    }
    try {
      await this.dataSource.query(INSERT_USAGE_EVENT_SQL, [
        String(event.companyId),
        null,
        event.kind,
        event.model,
        usage.prompt_tokens,
        usage.output_tokens,
        usage.thoughts_tokens,
        usage.cached_tokens,
        usage.total_tokens,
        event.rounds,
      ]);
    } catch (error) {
      this.logger.warn(
        { err: error, companyId: event.companyId, kind: event.kind },
        'No se pudo registrar el consumo del asistente de ventas',
      );
    }
  }
}
