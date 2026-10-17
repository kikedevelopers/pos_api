import type { DataSource } from 'typeorm';

import { AiCreditsAction, creditsDay } from '@/modules/ai/actions/ai-credits.action';
import { EMPTY_USAGE } from '@/modules/ai/internal/ai-usage';
import { GetAiUsageAction } from '@/modules/superadmin/actions/get-ai-usage.action';

import { cleanupCompany, createDisposableCompany, tryInitDataSource } from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) — créditos diarios y consumo de tokens de Place.
 *
 * Lo que no puede fallar:
 *   - Sin créditos asignados (0, el valor por defecto) no se puede preguntar.
 *   - El límite es por negocio y por día de Colombia, y N mensajes
 *     SIMULTÁNEOS nunca lo pasan (reserva atómica).
 *   - Un crédito devuelto se puede volver a usar; nunca queda negativo.
 *   - Los créditos y el consumo de un negocio no se mezclan con los de otro.
 *   - El consumo se agrega bien (totales, por día de Colombia, por modelo y por
 *     negocio).
 */

const COMPANY = '__E2E_AI_CREDITS__';
const OTHER_COMPANY = '__E2E_AI_CREDITS_OTHER__';

const canConnectPromise = tryInitDataSource();

describe('Place · créditos diarios y consumo (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let cid = 0;
  let otherCid = 0;
  let credits: AiCreditsAction;
  let usage: GetAiUsageAction;

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (ds as DataSource).query(sql, params);

  beforeAll(async () => {
    ds = await canConnectPromise;
    if (!ds) {
      return;
    }
    cid = await createDisposableCompany(ds, COMPANY);
    otherCid = await createDisposableCompany(ds, OTHER_COMPANY);
    credits = new AiCreditsAction(ds);
    usage = new GetAiUsageAction(ds, credits);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, cid);
    await cleanupCompany(ds, otherCid);
    await ds.destroy();
  });

  beforeEach(async () => {
    if (!ds) {
      return;
    }
    for (const company of [cid, otherCid]) {
      await q(`DELETE FROM ai_daily_credit_usage WHERE company_id = $1`, [String(company)]);
      await q(`DELETE FROM ai_usage_events WHERE company_id = $1`, [String(company)]);
      await q(`UPDATE companies SET ai_daily_credits = 0 WHERE id = $1`, [String(company)]);
    }
  });

  const itDb = (name: string, fn: () => Promise<void>): void => {
    it(name, async () => {
      if (!(await canConnectPromise)) {
        return; // sin BD en el runner: se omite limpio.
      }
      await fn();
    });
  };

  describe('créditos', () => {
    itDb('una cuenta nueva arranca en 0: bloqueada hasta que se le asignen', async () => {
      expect(await credits.status(cid)).toEqual({ daily_limit: 0, used_today: 0, remaining: 0 });
      expect(await credits.reserve(cid)).toBeNull();
    });

    itDb('con 3 créditos: 3 preguntas y la cuarta se bloquea', async () => {
      expect(await credits.setDailyCredits(cid, 3)).toBe(3);
      const results = [];
      for (let i = 0; i < 4; i += 1) {
        results.push(await credits.reserve(cid));
      }
      expect(results.map((r) => r?.status.remaining ?? null)).toEqual([2, 1, 0, null]);
      expect(await credits.status(cid)).toEqual({ daily_limit: 3, used_today: 3, remaining: 0 });
    });

    itDb('10 mensajes SIMULTÁNEOS con 3 créditos: exactamente 3 pasan', async () => {
      await credits.setDailyCredits(cid, 3);
      const results = await Promise.all(Array.from({ length: 10 }, () => credits.reserve(cid)));
      expect(results.filter((r) => r !== null)).toHaveLength(3);
      expect((await credits.status(cid)).used_today).toBe(3);
    });

    itDb('un crédito devuelto se puede volver a usar; nunca queda negativo', async () => {
      await credits.setDailyCredits(cid, 1);
      const reservation = await credits.reserve(cid);
      expect(reservation).not.toBeNull();
      expect(await credits.reserve(cid)).toBeNull();

      await credits.refund(reservation as NonNullable<typeof reservation>);
      expect((await credits.status(cid)).remaining).toBe(1);
      // Devolver de más no lo deja negativo.
      await credits.refund(reservation as NonNullable<typeof reservation>);
      await credits.refund(reservation as NonNullable<typeof reservation>);
      expect((await credits.status(cid)).used_today).toBe(0);
    });

    itDb('es por día de Colombia: el uso de ayer no cuenta hoy', async () => {
      await credits.setDailyCredits(cid, 1);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(await credits.reserve(cid, yesterday)).not.toBeNull();
      expect(await credits.reserve(cid, yesterday)).toBeNull();
      // Hoy arranca de nuevo.
      expect(await credits.reserve(cid)).not.toBeNull();
    });

    itDb('bajar el límite por debajo de lo usado bloquea de inmediato', async () => {
      await credits.setDailyCredits(cid, 5);
      await credits.reserve(cid);
      await credits.reserve(cid);
      await credits.setDailyCredits(cid, 1);
      expect(await credits.status(cid)).toEqual({ daily_limit: 1, used_today: 2, remaining: 0 });
      expect(await credits.reserve(cid)).toBeNull();
    });

    itDb('los créditos de un negocio no tocan los de otro', async () => {
      await credits.setDailyCredits(cid, 1);
      await credits.setDailyCredits(otherCid, 1);
      expect(await credits.reserve(cid)).not.toBeNull();
      expect(await credits.reserve(cid)).toBeNull();
      expect(await credits.reserve(otherCid)).not.toBeNull();
    });

    itDb('company inexistente: no se asigna ni se reserva', async () => {
      expect(await credits.setDailyCredits(999_999_999, 5)).toBeNull();
      expect(await credits.reserve(999_999_999)).toBeNull();
    });

    itDb('la BD rechaza créditos negativos', async () => {
      await expect(
        q(`UPDATE companies SET ai_daily_credits = -1 WHERE id = $1`, [String(cid)]),
      ).rejects.toThrow(/chk_companies_ai_daily_credits_non_negative/);
    });
  });

  describe('consumo de tokens', () => {
    const event = (
      company: number,
      kind: 'chat' | 'greeting',
      model: string,
      prompt: number,
      output: number,
      thoughts = 0,
    ) => ({
      company_id: company,
      user_id: null,
      kind,
      model,
      usage: {
        prompt_tokens: prompt,
        output_tokens: output,
        thoughts_tokens: thoughts,
        cached_tokens: 0,
        total_tokens: prompt + output + thoughts,
      },
      rounds: kind === 'chat' ? 2 : 1,
    });

    itDb('agrega totales, por día, por modelo y por negocio', async () => {
      await credits.setDailyCredits(cid, 7);
      await credits.reserve(cid);
      await credits.recordUsage(event(cid, 'chat', 'gemini-flash-lite-latest', 1000, 200, 50));
      await credits.recordUsage(event(cid, 'chat', 'gemini-flash-latest', 3000, 400));
      await credits.recordUsage(event(cid, 'greeting', 'gemini-flash-lite-latest', 100, 30));
      await credits.recordUsage(event(otherCid, 'chat', 'gemini-flash-lite-latest', 500, 50));

      const today = creditsDay();
      const tenant = await usage.tenant(cid, today, today);
      expect(tenant.totals).toEqual({
        prompt_tokens: 4100,
        output_tokens: 630,
        thoughts_tokens: 50,
        cached_tokens: 0,
        total_tokens: 4780,
        questions: 2,
        greetings: 1,
      });
      expect(tenant.credits).toEqual({ daily_limit: 7, used_today: 1, remaining: 6 });
      expect(tenant.daily.map((d) => [d.day, d.total_tokens])).toEqual([[today, 4780]]);
      expect(tenant.by_model.map((m) => [m.model, m.total_tokens])).toEqual([
        ['gemini-flash-latest', 3400],
        ['gemini-flash-lite-latest', 1380],
      ]);

      // El otro negocio no se mezcla.
      expect((await usage.tenant(otherCid, today, today)).totals.total_tokens).toBe(550);

      const global = await usage.global(today, today);
      const mine = global.by_company.find((c) => c.company_id === cid);
      expect(mine).toMatchObject({
        company_name: COMPANY,
        ai_daily_credits: 7,
        used_today: 1,
        total_tokens: 4780,
        questions: 2,
      });
      expect(global.totals.total_tokens).toBeGreaterThanOrEqual(4780 + 550);
    });

    itDb('una llamada sin consumo ni rondas no ensucia el registro', async () => {
      await credits.recordUsage({
        company_id: cid,
        user_id: null,
        kind: 'chat',
        model: 'x',
        usage: EMPTY_USAGE,
        rounds: 0,
      });
      const [{ n }] = await q<{ n: string }>(
        `SELECT count(*) AS n FROM ai_usage_events WHERE company_id = $1`,
        [String(cid)],
      );
      expect(Number(n)).toBe(0);
    });

    itDb('company inexistente en el detalle → 404', async () => {
      await expect(usage.tenant(999_999_999)).rejects.toThrow(/no existe/);
    });

    itDb('sin rango usa los últimos 30 días', async () => {
      const result = await usage.tenant(cid);
      expect(result.range.to).toBe(creditsDay());
    });
  });
});
