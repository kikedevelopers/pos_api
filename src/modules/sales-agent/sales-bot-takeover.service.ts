import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SalesBotTakeoverEntity } from './entities/sales-bot-takeover.entity';
import { nextDayStartBogota } from './internal/takeover-window';

/**
 * Toma de control HUMANA de un chat: cuando una persona del negocio responde
 * en una conversación, el agente se calla en ese chat hasta el inicio del día
 * siguiente (hora Colombia). Persistido en BD para sobrevivir reinicios.
 */
@Injectable()
export class SalesBotTakeoverService {
  constructor(
    @InjectRepository(SalesBotTakeoverEntity)
    private readonly repo: Repository<SalesBotTakeoverEntity>,
  ) {}

  /** Pausa el agente en el chat hasta mañana. Devuelve hasta cuándo. */
  async pause(
    companyId: number,
    channel: string,
    chatId: string,
    now: Date = new Date(),
  ): Promise<{ paused_until: string }> {
    const pausedUntil = nextDayStartBogota(now);
    const where = { company_id: String(companyId), channel, chat_id: chatId };
    const existing = await this.repo.findOne({ where });
    const entity = existing ?? this.repo.create(where);
    entity.paused_until = pausedUntil;
    await this.repo.save(entity);
    return { paused_until: pausedUntil.toISOString() };
  }

  /** `true` si un humano tomó este chat y la pausa sigue vigente. */
  async isPaused(
    companyId: number,
    channel: string,
    chatId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const entity = await this.repo.findOne({
      where: { company_id: String(companyId), channel, chat_id: chatId },
    });
    return Boolean(entity && entity.paused_until.getTime() > now.getTime());
  }
}
