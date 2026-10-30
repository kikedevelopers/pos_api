import type { Repository } from 'typeorm';

import { nextDayStartBogota } from '../internal/takeover-window';
import { SalesBotTakeoverService } from '../sales-bot-takeover.service';
import type { SalesBotTakeoverEntity } from '../entities/sales-bot-takeover.entity';

describe('nextDayStartBogota', () => {
  it('a media tarde en Colombia devuelve la medianoche siguiente (05:00 UTC)', () => {
    // 30-oct 15:00 Bogotá = 20:00 UTC
    const now = new Date('2026-10-30T20:00:00.000Z');
    expect(nextDayStartBogota(now).toISOString()).toBe('2026-10-31T05:00:00.000Z');
  });

  it('a las 23:30 de Bogotá (ya es otro día en UTC) sigue siendo la medianoche siguiente', () => {
    // 30-oct 23:30 Bogotá = 31-oct 04:30 UTC
    const now = new Date('2026-10-31T04:30:00.000Z');
    expect(nextDayStartBogota(now).toISOString()).toBe('2026-10-31T05:00:00.000Z');
  });

  it('justo a la medianoche de Bogotá pausa hasta la medianoche del otro día', () => {
    const now = new Date('2026-10-31T05:00:00.000Z');
    expect(nextDayStartBogota(now).toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });
});

describe('SalesBotTakeoverService', () => {
  const makeService = (existing: Partial<SalesBotTakeoverEntity> | null) => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn((partial: Partial<SalesBotTakeoverEntity>) => ({ ...partial })),
      save: jest.fn(async (entity: SalesBotTakeoverEntity) => entity),
    };
    const service = new SalesBotTakeoverService(
      repo as unknown as Repository<SalesBotTakeoverEntity>,
    );
    return { service, repo };
  };
  const now = new Date('2026-10-30T20:00:00.000Z');

  it('pause crea la pausa hasta la medianoche siguiente', async () => {
    const { service, repo } = makeService(null);
    const result = await service.pause(7, 'whatsapp', 'chat-1', now);
    const saved = repo.save.mock.calls[0][0] as SalesBotTakeoverEntity;
    expect(saved).toMatchObject({ company_id: '7', channel: 'whatsapp', chat_id: 'chat-1' });
    expect(saved.paused_until.toISOString()).toBe('2026-10-31T05:00:00.000Z');
    expect(result.paused_until).toBe('2026-10-31T05:00:00.000Z');
  });

  it('pause sobre un chat ya pausado solo extiende la fecha (no duplica)', async () => {
    const { service, repo } = makeService({
      company_id: '7',
      channel: 'whatsapp',
      chat_id: 'chat-1',
      paused_until: new Date('2026-10-29T05:00:00.000Z'),
    });
    await service.pause(7, 'whatsapp', 'chat-1', now);
    expect(repo.create).not.toHaveBeenCalled();
    const saved = repo.save.mock.calls[0][0] as SalesBotTakeoverEntity;
    expect(saved.paused_until.toISOString()).toBe('2026-10-31T05:00:00.000Z');
  });

  it('isPaused: true mientras la pausa esté vigente', async () => {
    const { service } = makeService({ paused_until: new Date('2026-10-31T05:00:00.000Z') });
    await expect(service.isPaused(7, 'whatsapp', 'chat-1', now)).resolves.toBe(true);
  });

  it('isPaused: false cuando la pausa ya venció (al día siguiente)', async () => {
    const { service } = makeService({ paused_until: new Date('2026-10-31T05:00:00.000Z') });
    const tomorrow = new Date('2026-10-31T13:00:00.000Z');
    await expect(service.isPaused(7, 'whatsapp', 'chat-1', tomorrow)).resolves.toBe(false);
  });

  it('isPaused: false si el chat nunca fue tomado', async () => {
    const { service } = makeService(null);
    await expect(service.isPaused(7, 'whatsapp', 'chat-1', now)).resolves.toBe(false);
  });
});
