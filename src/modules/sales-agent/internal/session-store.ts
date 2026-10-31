import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { ChatTurn } from '@/modules/ai/internal/gemini.types';

import { SalesBotConversationEntity } from '../entities/sales-bot-conversation.entity';

/**
 * Memoria de conversación por chat, PERSISTIDA en `sales_bot_conversations`.
 * Sobrevive a reinicios y deploys: el agente no olvida lo hablado ni vuelve a
 * saludar a mitad de una conversación.
 *
 * Cada conversación guarda los turnos del cliente y del vendedor (texto),
 * acotados por cantidad y por tiempo para no arrastrar charlas viejas. El día
 * del último mensaje (`last_day`) NO vence con la charla: si el cliente vuelve
 * el mismo día tras una pausa larga, no se le saluda otra vez.
 */

/** Chat de un canal de un negocio. */
export interface SessionKey {
  companyId: number;
  /** Canal (`telegram`, `whatsapp`, `whatsapp-web`): separa conversaciones. */
  channel: string;
  chatId: string;
}

/** Turnos máximos que se recuerdan por chat (cliente + vendedor). */
export const MAX_SESSION_TURNS = 40;

/** Una charla inactiva por más de esto se olvida (6 horas). */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class SellerSessionStore {
  constructor(
    @InjectRepository(SalesBotConversationEntity)
    private readonly repo: Repository<SalesBotConversationEntity>,
  ) {}

  /** Clave de un chat de un canal de un negocio. */
  static key(companyId: number, channel: string, chatId: string): SessionKey {
    return { companyId, channel, chatId };
  }

  /** Turnos vigentes de la conversación (vacío si no existe o venció). */
  async history(key: SessionKey): Promise<ChatTurn[]> {
    const row = await this.find(key);
    return row && !isExpired(row) ? row.turns : [];
  }

  /** Agrega un turno y devuelve el historial ya recortado. */
  async append(key: SessionKey, turn: ChatTurn): Promise<ChatTurn[]> {
    const row = await this.findOrCreate(key);
    if (isExpired(row)) {
      clearConversation(row);
    }
    row.turns = [...row.turns, turn].slice(-MAX_SESSION_TURNS);
    await this.repo.save(row);
    return row.turns;
  }

  /**
   * Registra que el cliente escribió en `day` (YYYY-MM-DD, hora Colombia) y
   * devuelve `true` si es su PRIMER mensaje de ese día en este chat. Llamarlo
   * una vez por mensaje entrante, ANTES de `append`. Si la charla venció, la
   * olvida (empieza de cero) pero respeta el día: no se saluda dos veces el
   * mismo día.
   */
  async markDay(key: SessionKey, day: string): Promise<boolean> {
    const row = await this.findOrCreate(key);
    if (isExpired(row)) {
      clearConversation(row);
    }
    const isFirst = row.last_day !== day;
    row.last_day = day;
    // Toca `updated_at` aunque no cambie nada más (marca actividad).
    row.updated_at = new Date();
    await this.repo.save(row);
    return isFirst;
  }

  /**
   * Registra un pedido cerrado. Devuelve `true` la PRIMERA vez que se ve esa
   * firma en la conversación y `false` si ya se había cerrado (doble cierre del
   * modelo) — el canal usa esto para no avisarle dos veces al dueño.
   */
  async rememberOrder(key: SessionKey, signature: string): Promise<boolean> {
    const row = await this.findOrCreate(key);
    if (row.order_signatures.includes(signature)) {
      return false;
    }
    row.order_signatures = [...row.order_signatures, signature];
    await this.repo.save(row);
    return true;
  }

  /** Olvida la conversación (p. ej. el cliente escribió /reiniciar). */
  /**
   * Olvida la conversación. Si está EN SILENCIO por mensajes fuera de tema, se
   * conserva ese estado: reiniciar no es una forma de saltarse el filtro.
   */
  async reset(key: SessionKey): Promise<void> {
    const row = await this.find(key);
    if (row?.muted_at) {
      await this.repo.update(
        { id: row.id },
        { turns: [], cart: null, order_signatures: [], last_day: null },
      );
      return;
    }
    await this.repo.delete(where(key));
  }

  private find(key: SessionKey): Promise<SalesBotConversationEntity | null> {
    return this.repo.findOne({ where: where(key) });
  }

  private async findOrCreate(key: SessionKey): Promise<SalesBotConversationEntity> {
    const existing = await this.find(key);
    if (existing) {
      return existing;
    }
    return this.repo.create({ ...where(key), turns: [], order_signatures: [], last_day: null });
  }
}

const where = (key: SessionKey) => ({
  company_id: String(key.companyId),
  channel: key.channel,
  chat_id: key.chatId,
});

const isExpired = (row: SalesBotConversationEntity, now: number = Date.now()): boolean =>
  row.updated_at instanceof Date && now - row.updated_at.getTime() > SESSION_TTL_MS;

/** Olvida lo hablado (turnos y pedidos), conservando el día del último mensaje. */
const clearConversation = (row: SalesBotConversationEntity): void => {
  row.turns = [];
  row.order_signatures = [];
};
