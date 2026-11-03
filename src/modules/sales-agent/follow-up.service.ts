import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import type { SalesBotConfig } from '@/config/sales-bot.config';
import { dayjs, nowBogota } from '@/common/utils/dayjs';
import { GeminiClient } from '@/modules/ai/internal/gemini-client';
import { addUsage, EMPTY_USAGE } from '@/modules/ai/internal/ai-usage';
import {
  accessibleCompanyIdsSql,
  accessibleProductsPredicate,
} from '@/modules/products/internal/accessible-products.helper';
import { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';

import { SALES_BOT_CHANNELS } from './entities/sales-bot-config.entity';
import { SalesAgentFollowUpEntity } from './entities/sales-agent-follow-up.entity';
import {
  buildFollowUpPrompt,
  fallbackFollowUpMessage,
  FOLLOW_UP_MAX_LENGTH,
  FOLLOW_UP_RESPONSE_SCHEMA,
  naturalProductName,
  normalizeFollowUpMessage,
  parseFollowUpDraft,
  type FollowUpCatalogItem,
  type FollowUpPurchasedItem,
  type FollowUpSaleSummary,
} from './internal/follow-up-prompt';
import { timeOfDayFromHour } from './internal/greeting';
import { SELLER_ASSISTANT_NAME } from './internal/seller-prompt';
import { SELLABLE_SQL } from './internal/sellable-sql';
import { SellerSessionStore, type SessionKey } from './internal/session-store';
import { SalesBotConfigService } from './sales-bot-config.service';
import { SalesBotSettingsService } from './sales-bot-settings.service';

/** Ventas que el agente analiza para personalizar el saludo. */
export const FOLLOW_UP_RECENT_SALES = 3;
/** Productos del catálogo que se le pasan al agente como candidatos. */
export const FOLLOW_UP_CATALOG_LIMIT = 120;
/** Borradores descartados que se le recuerdan al agente para no repetirse. */
export const FOLLOW_UP_MAX_PREVIOUS_DRAFTS = 4;
/**
 * Razonamiento MEDIO: el agente debe cruzar compras con catálogo y elegir qué
 * combina, sin la latencia de un análisis profundo.
 */
export const FOLLOW_UP_THINKING_BUDGET = 1024;
/** Tope de salida (razonamiento + JSON) con margen amplio. */
export const FOLLOW_UP_MAX_OUTPUT_TOKENS = 8192;
/** Temperatura alta: cada cliente recibe un mensaje distinto. */
export const FOLLOW_UP_TEMPERATURE = 1;
/** Días durante los que el seguimiento sirve de contexto si el cliente responde. */
export const FOLLOW_UP_CONTEXT_WINDOW_DAYS = 7;

/** Por qué no se puede hacer seguimiento (la UI lo explica). */
export type FollowUpUnavailableReason = 'agent_not_ready' | 'whatsapp_disabled';

export interface FollowUpAvailability {
  enabled: boolean;
  reason: FollowUpUnavailableReason | null;
}

/** Producto que el borrador menciona (para que la persona vea el porqué). */
export interface FollowUpProductRef {
  id: number;
  name: string;
}

export interface FollowUpDraftResult {
  message: string;
  customer: { id: number; name: string; phone: string };
  recalled: FollowUpProductRef[];
  suggested: FollowUpProductRef[];
  /** Cuántas ventas se analizaron (0..3). */
  analyzed_sales: number;
  /** `true` si la IA falló y se usó el saludo de respaldo sin productos. */
  is_fallback: boolean;
}

export interface RecordFollowUpInput {
  customer_id: number;
  message: string;
  chat_id: string;
  phone: string;
  recalled_product_ids?: number[];
  suggested_product_ids?: number[];
}

export interface FollowUpView {
  id: number;
  customer_id: number;
  message: string;
  created_at: string;
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
}

interface SaleLineRow {
  sale_id: string;
  sold_at: Date | string;
  family_id: string;
  family_name: string;
  category: string | null;
  in_stock: boolean;
  last_restock: Date | string | null;
}

interface CatalogRow {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
}

interface RelatedRow {
  product_id: string;
  related: Array<{ product_id: number; kind: string }> | null;
}

/**
 * Seguimientos del agente a clientes (Informes → Clientes).
 *
 * `draft` arma el contexto REAL (últimas ventas del cliente + catálogo que se
 * puede ofrecer), pide al modelo un saludo personal con salida estructurada y
 * valida que todo lo que menciona exista; si el modelo se sale, se le pide otro
 * con la razón y, si vuelve a fallar, se usa un saludo sin productos. Nunca se
 * envía nada desde aquí: el envío lo hace el escritorio (WhatsApp por QR) y
 * luego `record` lo registra para que el agente tenga el contexto cuando el
 * cliente responda (`attachPendingContext`, desde el relay).
 */
@Injectable()
export class FollowUpService {
  private readonly logger = new Logger(FollowUpService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    private readonly gemini: GeminiClient,
    private readonly botSettings: SalesBotSettingsService,
    private readonly botConfig: SalesBotConfigService,
    private readonly access: SalesAgentAccessService,
    private readonly sessions: SellerSessionStore,
    @InjectRepository(SalesAgentFollowUpEntity)
    private readonly repo: Repository<SalesAgentFollowUpEntity>,
  ) {}

  private get config(): SalesBotConfig {
    return this.configService.getOrThrow<SalesBotConfig>('salesBot');
  }

  /**
   * ¿Se puede hacer seguimiento? El agente debe estar habilitado (lo cubre el
   * guard), la IA configurada y el canal de WhatsApp encendido: si el agente no
   * atiende WhatsApp, la respuesta del cliente no tendría quién la conteste.
   */
  async availability(companyId: number): Promise<FollowUpAvailability> {
    if (!this.gemini.isEnabled()) {
      return { enabled: false, reason: 'agent_not_ready' };
    }
    const whatsapp = await this.botConfig.getEntity(companyId, SALES_BOT_CHANNELS.WHATSAPP);
    if (!whatsapp?.enabled) {
      return { enabled: false, reason: 'whatsapp_disabled' };
    }
    return { enabled: true, reason: null };
  }

  async draft(
    companyId: number,
    customerId: number,
    previousDrafts: string[] = [],
  ): Promise<FollowUpDraftResult> {
    if (!this.gemini.isEnabled()) {
      throw new BadRequestException({
        code: 'AGENT_NOT_READY',
        message: 'El agente no está disponible en este momento.',
      });
    }

    const customer = await this.loadCustomer(companyId, customerId);
    const phone = customer.phone?.replace(/\D/g, '') ?? '';
    if (phone.length < 7) {
      throw new BadRequestException({
        code: 'CUSTOMER_WITHOUT_PHONE',
        message: 'Este cliente no tiene un número de teléfono para escribirle.',
      });
    }

    const [settings, businessName] = await Promise.all([
      this.botSettings.get(companyId),
      this.businessName(companyId),
    ]);
    const hideStock = settings.stock_policy === 'offer_always';
    const { sales, purchased } = await this.loadRecentPurchases(companyId, customerId, hideStock);
    const catalog = await this.loadCatalog(companyId, purchased, hideStock);

    const assistantName = settings.bot_name?.trim() || SELLER_ASSISTANT_NAME;
    const timeOfDay = timeOfDayFromHour(nowBogota().hour());
    const lastDate = sales[0]?.date ?? null;
    const daysSinceLastPurchase =
      lastDate === null ? null : Math.max(0, nowBogota().startOf('day').diff(dayjs.tz(lastDate, 'America/Bogota'), 'day'));

    const allowed = {
      purchased: new Set(purchased.map((item) => item.id)),
      catalog: new Set(catalog.map((item) => item.id)),
      outOfStock: new Set(
        purchased.filter((item) => item.in_stock === false).map((item) => item.id),
      ),
    };
    const names = new Map<number, string>([
      ...purchased.map((item): [number, string] => [item.id, item.name]),
      ...catalog.map((item): [number, string] => [item.id, item.name]),
    ]);
    const customerOut = { id: Number(customer.id), name: customer.name, phone };
    const prompt = buildFollowUpPrompt({
      businessName,
      assistantName,
      personality: settings.personality,
      greetingStyle: settings.greeting_style,
      customerName: customer.name,
      timeOfDay,
      daysSinceLastPurchase,
      recentSales: sales,
      purchased,
      catalog,
      previousDrafts: previousDrafts.slice(-FOLLOW_UP_MAX_PREVIOUS_DRAFTS),
      hideStock,
    });

    const model = this.gemini.resolveModel(this.config.model);
    let usage = EMPTY_USAGE;
    let rounds = 0;
    let correction: string | null = null;
    try {
      // Dos intentos: si el primero se sale del contexto, el segundo recibe la
      // razón exacta para corregirse.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await this.gemini.streamRound(
          this.buildRequest(prompt, correction),
          { model, onText: () => undefined },
        );
        usage = addUsage(usage, result.usage);
        rounds += 1;
        if (result.error) {
          correction = null;
          continue;
        }
        const parsed = parseFollowUpDraft(result.text, allowed);
        if (parsed.ok) {
          const toRefs = (ids: number[]): FollowUpProductRef[] =>
            ids.map((id) => ({ id, name: naturalProductName(names.get(id) ?? '') }));
          return {
            message: parsed.draft.message,
            customer: customerOut,
            recalled: toRefs(parsed.draft.recalled_product_ids),
            suggested: toRefs(parsed.draft.suggested_product_ids),
            analyzed_sales: sales.length,
            is_fallback: false,
          };
        }
        this.logger.warn(
          { companyId, customerId, reason: parsed.reason },
          'Borrador de seguimiento rechazado; se pide otro.',
        );
        correction = parsed.reason;
      }
    } finally {
      await this.access.recordUsage({ companyId, kind: 'sales_agent', model, usage, rounds });
    }

    return {
      message: fallbackFollowUpMessage({
        customerName: customer.name,
        businessName,
        assistantName,
        personality: settings.personality,
        timeOfDay,
      }),
      customer: customerOut,
      recalled: [],
      suggested: [],
      analyzed_sales: sales.length,
      is_fallback: true,
    };
  }

  /**
   * Registra un seguimiento YA ENVIADO por el escritorio. Los ids de productos
   * se guardan solo si son del negocio (auditoría, no confianza ciega).
   */
  async record(
    companyId: number,
    user: { user_id: number; name?: string; lastname?: string },
    input: RecordFollowUpInput,
  ): Promise<FollowUpView> {
    const customer = await this.loadCustomer(companyId, input.customer_id);
    const message = normalizeFollowUpMessage(input.message ?? '');
    if (!message || message.length > FOLLOW_UP_MAX_LENGTH) {
      throw new BadRequestException('El mensaje del seguimiento no es válido.');
    }
    const phone = input.phone.replace(/\D/g, '');
    if (phone.length < 7 || phone.length > 20) {
      throw new BadRequestException('El número del cliente no es válido.');
    }
    const chatId = input.chat_id.trim();
    if (!chatId) {
      throw new BadRequestException('Falta el chat al que se envió el seguimiento.');
    }

    const productIds = [
      ...(input.recalled_product_ids ?? []),
      ...(input.suggested_product_ids ?? []),
    ];
    const accessible = await this.accessibleIds(companyId, productIds);
    const keep = (ids: number[] | undefined): string[] =>
      (ids ?? []).filter((id) => accessible.has(id)).map(String);

    const sentBy = [user.name, user.lastname].filter(Boolean).join(' ').trim();
    const saved = await this.repo.save(
      this.repo.create({
        company_id: String(companyId),
        customer_id: customer.id,
        channel: 'whatsapp-web',
        chat_id: chatId,
        phone,
        message,
        recalled_product_ids: keep(input.recalled_product_ids),
        suggested_product_ids: keep(input.suggested_product_ids),
        sent_by_user_id: String(user.user_id),
        sent_by_name: sentBy || null,
        context_attached_at: null,
      }),
    );
    return {
      id: Number(saved.id),
      customer_id: Number(saved.customer_id),
      message: saved.message,
      created_at: saved.created_at.toISOString(),
    };
  }

  /**
   * Si el cliente responde a un seguimiento reciente, mete ese mensaje en la
   * conversación del agente como si él lo hubiera dicho: así contesta sabiendo
   * qué le escribió. Se busca por chat o por número (WhatsApp puede responder
   * desde un chat `@lid`). Marca también el día del envío para que el agente no
   * vuelva a presentarse. Nunca lanza: sin contexto, el agente igual responde.
   */
  async attachPendingContext(
    key: SessionKey,
    chat: { chatId: string; phone?: string },
  ): Promise<boolean> {
    try {
      const phone = chat.phone?.replace(/\D/g, '') || phoneFromChatId(chat.chatId);
      const since = new Date(Date.now() - FOLLOW_UP_CONTEXT_WINDOW_DAYS * 86_400_000);
      const qb = this.repo
        .createQueryBuilder('f')
        .where('f.company_id = :companyId', { companyId: String(key.companyId) })
        .andWhere('f.context_attached_at IS NULL')
        .andWhere('f.created_at >= :since', { since })
        .orderBy('f.created_at', 'DESC');
      if (phone) {
        qb.andWhere('(f.chat_id = :chatId OR f.phone = :phone)', { chatId: chat.chatId, phone });
      } else {
        qb.andWhere('f.chat_id = :chatId', { chatId: chat.chatId });
      }
      const pending = await qb.getMany();
      const latest = pending[0];
      if (!latest) {
        return false;
      }

      const sentDay = dayjs(latest.created_at).tz('America/Bogota').format('YYYY-MM-DD');
      await this.sessions.markDay(key, sentDay);
      await this.sessions.append(key, { role: 'assistant', content: latest.message });
      // Los anteriores quedan superados por el más reciente.
      await this.repo.update(
        pending.map((row) => row.id),
        { context_attached_at: new Date() },
      );
      return true;
    } catch (error) {
      this.logger.warn({ err: error, companyId: key.companyId }, 'No se pudo adjuntar el seguimiento.');
      return false;
    }
  }

  /** Último seguimiento enviado a cada cliente (para la tabla del informe). */
  async lastByCustomer(companyId: number): Promise<Array<{ customer_id: number; created_at: string }>> {
    const rows = await this.dataSource.query<Array<{ customer_id: string; created_at: Date }>>(
      `SELECT customer_id, MAX(created_at) AS created_at
         FROM sales_agent_follow_ups
        WHERE company_id = $1
        GROUP BY customer_id`,
      [String(companyId)],
    );
    return rows.map((row) => ({
      customer_id: Number(row.customer_id),
      created_at: new Date(row.created_at).toISOString(),
    }));
  }

  private buildRequest(prompt: string, correction: string | null) {
    const parts = [{ text: prompt }];
    if (correction) {
      parts.push({
        text: `Tu borrador anterior fue rechazado: ${correction} Escribe uno nuevo que cumpla TODAS las reglas de oro.`,
      });
    }
    return {
      contents: [{ role: 'user' as const, parts }],
      generationConfig: {
        temperature: FOLLOW_UP_TEMPERATURE,
        topP: 0.95,
        // El razonamiento NO respeta el presupuesto al pie de la letra y cuenta
        // dentro del tope: con poco margen el JSON salía cortado (MAX_TOKENS).
        maxOutputTokens: FOLLOW_UP_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseSchema: FOLLOW_UP_RESPONSE_SCHEMA,
        thinkingConfig: { thinkingBudget: FOLLOW_UP_THINKING_BUDGET },
      },
    } as unknown as Parameters<GeminiClient['streamRound']>[0];
  }

  private async loadCustomer(companyId: number, customerId: number): Promise<CustomerRow> {
    const rows = await this.dataSource.query<CustomerRow[]>(
      `SELECT id, name, phone
         FROM customers
        WHERE id = $1 AND company_id = $2 AND is_archived = false
        LIMIT 1`,
      [String(customerId), String(companyId)],
    );
    const customer = rows[0];
    if (!customer) {
      throw new NotFoundException('Cliente no encontrado.');
    }
    return customer;
  }

  private async businessName(companyId: number): Promise<string> {
    const rows = await this.dataSource.query<Array<{ name: string | null }>>(
      'SELECT name FROM companies WHERE id = $1 LIMIT 1',
      [String(companyId)],
    );
    return rows[0]?.name?.trim() || 'nuestro negocio';
  }

  /**
   * Últimas ventas del cliente (mismas condiciones que el informe RFM: venta no
   * eliminada) con sus productos agrupados por familia BASE. Por familia: si hay
   * existencias hoy y si entró mercancía después de que la compró.
   */
  private async loadRecentPurchases(
    companyId: number,
    customerId: number,
    hideStock: boolean,
  ): Promise<{ sales: FollowUpSaleSummary[]; purchased: FollowUpPurchasedItem[] }> {
    const rows = await this.dataSource.query<SaleLineRow[]>(
      `
      WITH recent AS (
        SELECT si.id, COALESCE(si.sold_at, si.created_at) AS sold_at
          FROM sale_invoices si
         WHERE si.company_id = $1
           AND si.customer_id = $2
           AND si.ticket_type = 'SALE'
           AND si.is_deleted = false
         ORDER BY COALESCE(si.sold_at, si.created_at) DESC
         LIMIT $3
      )
      SELECT DISTINCT ON (r.id, fam.id)
        r.id AS sale_id,
        r.sold_at,
        fam.id AS family_id,
        fam.name AS family_name,
        cat.name AS category,
        (fam.stock > 0) AS in_stock,
        (
          SELECT MAX(pl.created_at)
            FROM purchase_lines pl
            JOIN purchases pu ON pu.id = pl.purchase_id
            JOIN products pp ON pp.id = pl.product_id
           WHERE pl.company_id = fam.company_id
             AND pu.is_deleted = false
             AND pu.status = 'RECEIVED'
             AND COALESCE(pp.parent_id, pp.id) = fam.id
        ) AS last_restock
      FROM recent r
      JOIN sale_invoice_lines l ON l.sale_invoice_id = r.id AND l.company_id = $1
      JOIN products p ON p.id = l.product_id
      JOIN products fam ON fam.id = COALESCE(p.parent_id, p.id)
      LEFT JOIN categories cat ON cat.id = fam.category_id
      ORDER BY r.id, fam.id
      `,
      [String(companyId), String(customerId), FOLLOW_UP_RECENT_SALES],
    );

    const bySale = new Map<string, { date: string; items: string[] }>();
    const families = new Map<number, FollowUpPurchasedItem & { last_at: number }>();
    for (const row of rows) {
      const soldAt = dayjs(row.sold_at).tz('America/Bogota');
      const date = soldAt.format('YYYY-MM-DD');
      const sale = bySale.get(row.sale_id) ?? { date, items: [] };
      sale.items.push(row.family_name);
      bySale.set(row.sale_id, sale);

      const id = Number(row.family_id);
      const existing = families.get(id);
      const lastAt = Math.max(existing?.last_at ?? 0, soldAt.valueOf());
      const restockAt = row.last_restock ? new Date(row.last_restock).getTime() : 0;
      families.set(id, {
        id,
        name: row.family_name,
        category: row.category,
        last_bought: dayjs(lastAt).tz('America/Bogota').format('YYYY-MM-DD'),
        last_at: lastAt,
        times: (existing?.times ?? 0) + 1,
        in_stock: hideStock ? null : Boolean(row.in_stock),
        restocked: !hideStock && restockAt > lastAt,
      });
    }

    const sales = [...bySale.values()].sort((a, b) => b.date.localeCompare(a.date));
    const purchased = [...families.values()]
      .sort((a, b) => b.times - a.times || b.last_at - a.last_at)
      .map(({ last_at: _lastAt, ...item }) => item);
    return { sales, purchased };
  }

  /**
   * Candidatos a sugerir: productos BASE vendibles del negocio (propios o
   * compartidos), con existencias salvo que el negocio ofrezca siempre. Primero
   * los que la ficha marca como complemento de lo comprado, luego los de las
   * mismas categorías y después los más vendidos.
   */
  private async loadCatalog(
    companyId: number,
    purchased: FollowUpPurchasedItem[],
    hideStock: boolean,
  ): Promise<FollowUpCatalogItem[]> {
    const purchasedIds = purchased.map((item) => item.id);
    const complementsOf = await this.complementsFor(purchasedIds);
    const complementIds = [...complementsOf.keys()];
    const categories = [...new Set(purchased.map((item) => item.category).filter(Boolean))];

    // $1 company · $2 categorías · $3 complementos · $4 comprados · $5 límite; acceso desde $6.
    const access = accessibleProductsPredicate('p', companyId, 6);
    const rows = await this.dataSource.query<CatalogRow[]>(
      `
      SELECT p.id, p.name, cat.name AS category, prof.description
        FROM products p
        LEFT JOIN categories cat ON cat.id = p.category_id
        LEFT JOIN product_assistant_profiles prof ON prof.product_id = p.id
        LEFT JOIN (
          SELECT COALESCE(sp.parent_id, sp.id) AS family_id, SUM(l.quantity) AS units
            FROM sale_invoice_lines l
            JOIN sale_invoices s ON s.id = l.sale_invoice_id
            JOIN products sp ON sp.id = l.product_id
           WHERE l.company_id = $1::bigint
             AND s.is_deleted = false
             AND COALESCE(s.sold_at, s.created_at) >= NOW() - INTERVAL '60 days'
           GROUP BY 1
        ) sold ON sold.family_id = p.id
       WHERE p.company_id IN (${accessibleCompanyIdsSql('$1')})
         AND ${access.sql}
         AND ${SELLABLE_SQL}
         AND p.parent_id IS NULL
         AND NOT (p.id = ANY($4::bigint[]))
         ${hideStock ? '' : 'AND p.stock > 0'}
       ORDER BY
         (p.id = ANY($3::bigint[])) DESC,
         COALESCE(cat.name = ANY($2::text[]), false) DESC,
         COALESCE(sold.units, 0) DESC,
         p.name ASC
       LIMIT $5
      `,
      [
        String(companyId),
        categories,
        complementIds,
        purchasedIds,
        FOLLOW_UP_CATALOG_LIMIT,
        ...access.params,
      ],
    );
    return rows.map((row) => {
      const id = Number(row.id);
      const complements = complementsOf.get(id);
      return {
        id,
        name: row.name,
        category: row.category,
        description: row.description?.trim() || null,
        ...(complements ? { complements } : {}),
      };
    });
  }

  /** Mapa producto-complemento → productos comprados a los que complementa. */
  private async complementsFor(purchasedIds: number[]): Promise<Map<number, number[]>> {
    const map = new Map<number, number[]>();
    if (purchasedIds.length === 0) {
      return map;
    }
    const rows = await this.dataSource.query<RelatedRow[]>(
      `SELECT product_id, related
         FROM product_assistant_profiles
        WHERE product_id = ANY($1::bigint[])`,
      [purchasedIds],
    );
    for (const row of rows) {
      for (const ref of row.related ?? []) {
        if (ref?.kind !== 'complement' || !Number.isSafeInteger(ref.product_id)) {
          continue;
        }
        const list = map.get(ref.product_id) ?? [];
        list.push(Number(row.product_id));
        map.set(ref.product_id, list);
      }
    }
    return map;
  }

  private async accessibleIds(companyId: number, ids: number[]): Promise<Set<number>> {
    const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (unique.length === 0) {
      return new Set();
    }
    const access = accessibleProductsPredicate('p', companyId, 2);
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT p.id FROM products p WHERE p.id = ANY($1::bigint[]) AND ${access.sql}`,
      [unique, ...access.params],
    );
    return new Set(rows.map((row) => Number(row.id)));
  }
}

/** Dígitos del número en un JID de número (`57300…@s.whatsapp.net`); vacío si es `@lid`. */
export const phoneFromChatId = (chatId: string): string =>
  chatId.endsWith('@s.whatsapp.net') ? chatId.split('@')[0].split(':')[0].replace(/\D/g, '') : '';
