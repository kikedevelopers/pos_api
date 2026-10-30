import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';

import {
  DAILY_CREDITS_STATUS_SQL,
  INSERT_USAGE_EVENT_SQL,
  REFUND_DAILY_CREDIT_SQL,
  RESERVE_DAILY_CREDIT_SQL,
  SET_DAILY_CREDITS_SQL,
} from '../internal/ai-credits-sql';
import { toCreditsStatus, type AiCreditsStatus } from '../internal/ai-usage';
import type { GeminiUsage } from '../internal/gemini.types';

/** Día calendario de Colombia (los créditos se reinician a medianoche de Bogotá). */
export const creditsDay = (now: Date = new Date()): string =>
  dayjs(now).tz(APP_TIMEZONE).format('YYYY-MM-DD');

/**
 * Tipo de consumo de IA de una cuenta: Place (`chat`, `greeting`) y el
 * asistente de ventas (`sales_agent`, `sales_agent_audio`, `catalog_suggest`).
 */
export type AiUsageKind =
  | 'chat'
  | 'greeting'
  | 'sales_agent'
  | 'sales_agent_audio'
  | 'catalog_suggest';

export interface AiUsageEvent {
  company_id: number;
  user_id: number | null;
  kind: AiUsageKind;
  model: string;
  usage: GeminiUsage;
  rounds: number;
}

/** Reserva hecha para un mensaje: con ella se devuelve si la respuesta falla. */
export interface CreditReservation {
  company_id: number;
  day: string;
  status: AiCreditsStatus;
}

/**
 * Créditos diarios y consumo de tokens de Place.
 *
 * Cada mensaje al chat reserva 1 crédito ANTES de llamar a Gemini (atómico,
 * por company y día de Colombia). Si la respuesta falla por un error nuestro o
 * de Gemini, se devuelve. El consumo de tokens se registra aparte y nunca
 * rompe el chat.
 */
@Injectable()
export class AiCreditsAction {
  private readonly logger = new Logger(AiCreditsAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async status(company_id: number, now: Date = new Date()): Promise<AiCreditsStatus> {
    const [row] = await this.dataSource.query<Array<{ daily_limit: number; used_today: number }>>(
      DAILY_CREDITS_STATUS_SQL,
      [String(company_id), creditsDay(now)],
    );
    return toCreditsStatus(Number(row?.daily_limit ?? 0), Number(row?.used_today ?? 0));
  }

  /** Reserva un crédito del día; `null` si la cuenta ya no tiene. */
  async reserve(company_id: number, now: Date = new Date()): Promise<CreditReservation | null> {
    const day = creditsDay(now);
    const [row] = await this.dataSource.query<Array<{ messages: number; daily_limit: number }>>(
      RESERVE_DAILY_CREDIT_SQL,
      [String(company_id), day],
    );
    if (!row) {
      return null;
    }
    return {
      company_id,
      day,
      status: toCreditsStatus(Number(row.daily_limit), Number(row.messages)),
    };
  }

  /** Devuelve el crédito de una reserva (nunca lanza: es best-effort). */
  async refund(reservation: CreditReservation): Promise<void> {
    try {
      await this.dataSource.query(REFUND_DAILY_CREDIT_SQL, [
        String(reservation.company_id),
        reservation.day,
      ]);
    } catch (error) {
      this.logger.warn(
        { err: error, companyId: reservation.company_id },
        'No se pudo devolver el crédito',
      );
    }
  }

  async setDailyCredits(company_id: number, daily_credits: number): Promise<number | null> {
    const rows = await this.dataSource.query<Array<{ ai_daily_credits: number }>>(
      SET_DAILY_CREDITS_SQL,
      [String(company_id), daily_credits],
    );
    // UPDATE ... RETURNING con `query` devuelve [filas, count].
    const updated = Array.isArray(rows[0])
      ? (rows[0] as Array<{ ai_daily_credits: number }>)
      : rows;
    return updated[0] ? Number(updated[0].ai_daily_credits) : null;
  }

  /** Registra los tokens de una llamada a Gemini (nunca lanza). */
  async recordUsage(event: AiUsageEvent): Promise<void> {
    if (event.usage.total_tokens === 0 && event.rounds === 0) {
      return;
    }
    try {
      await this.dataSource.query(INSERT_USAGE_EVENT_SQL, [
        String(event.company_id),
        event.user_id !== null ? String(event.user_id) : null,
        event.kind,
        event.model,
        event.usage.prompt_tokens,
        event.usage.output_tokens,
        event.usage.thoughts_tokens,
        event.usage.cached_tokens,
        event.usage.total_tokens,
        event.rounds,
      ]);
    } catch (error) {
      this.logger.warn(
        { err: error, companyId: event.company_id },
        'No se pudo registrar el consumo de IA',
      );
    }
  }
}
