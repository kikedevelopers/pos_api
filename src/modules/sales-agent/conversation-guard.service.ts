import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { SalesBotConversationEntity } from './entities/sales-bot-conversation.entity';
import type { SessionKey } from './internal/session-store';

/** Estado del filtro de una conversación. */
export interface GuardState {
  strikes: number;
  muted: boolean;
}

const where = (key: SessionKey) => ({
  company_id: String(key.companyId),
  channel: key.channel,
  chat_id: key.chatId,
});

/**
 * Conteo de mensajes fuera de tema y silencio por conversación (columnas
 * `off_topic_strikes` / `muted_at` de `sales_bot_conversations`). Las
 * actualizaciones son atómicas en SQL: dos mensajes seguidos no se pisan.
 */
@Injectable()
export class ConversationGuardService {
  constructor(
    @InjectRepository(SalesBotConversationEntity)
    private readonly repo: Repository<SalesBotConversationEntity>,
  ) {}

  async get(key: SessionKey): Promise<GuardState> {
    const row = await this.repo.findOne({
      where: where(key),
      select: { id: true, off_topic_strikes: true, muted_at: true },
    });
    return { strikes: row?.off_topic_strikes ?? 0, muted: Boolean(row?.muted_at) };
  }

  /** Suma un mensaje fuera de tema y devuelve el total. */
  async addStrike(key: SessionKey): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update(SalesBotConversationEntity)
      .set({ off_topic_strikes: () => 'off_topic_strikes + 1' })
      .where('company_id = :company AND channel = :channel AND chat_id = :chat', {
        company: String(key.companyId),
        channel: key.channel,
        chat: key.chatId,
      })
      .returning(['off_topic_strikes'])
      .execute();
    const rows = Array.isArray(result.raw)
      ? (result.raw as Array<{ off_topic_strikes: number }>)
      : [];
    return Number(rows[0]?.off_topic_strikes ?? 1);
  }

  /** Un mensaje del negocio: el conteo vuelve a cero. */
  async resetStrikes(key: SessionKey): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(SalesBotConversationEntity)
      .set({ off_topic_strikes: 0 })
      .where('company_id = :company AND channel = :channel AND chat_id = :chat', {
        company: String(key.companyId),
        channel: key.channel,
        chat: key.chatId,
      })
      .andWhere('off_topic_strikes > 0')
      .execute();
  }

  /** Se despidió: la conversación queda en silencio. */
  async mute(key: SessionKey): Promise<void> {
    await this.repo.update(where(key), { muted_at: new Date() });
  }

  /** Volvió a ser algo del negocio: sale del silencio con el conteo en cero. */
  async unmute(key: SessionKey): Promise<void> {
    await this.repo.update(where(key), { muted_at: null, off_topic_strikes: 0 });
  }
}
