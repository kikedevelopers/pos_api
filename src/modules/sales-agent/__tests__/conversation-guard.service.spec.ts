import type { Repository } from 'typeorm';

import { ConversationGuardService } from '../conversation-guard.service';
import type { SalesBotConversationEntity } from '../entities/sales-bot-conversation.entity';

const key = { companyId: 7, channel: 'whatsapp-web', chatId: '57300@s.whatsapp.net' };

const make = (
  row: Partial<SalesBotConversationEntity> | null = null,
  returned = [{ off_topic_strikes: 2 }],
) => {
  const calls: Array<[string, unknown[]]> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const name of ['update', 'set', 'where', 'andWhere', 'returning']) {
    qb[name] = jest.fn((...args: unknown[]) => {
      calls.push([name, args]);
      return qb;
    });
  }
  qb.execute = jest.fn(() => Promise.resolve({ raw: returned }));
  const repo = {
    findOne: jest.fn(() => Promise.resolve(row)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    createQueryBuilder: jest.fn(() => qb),
  };
  const service = new ConversationGuardService(
    repo as unknown as Repository<SalesBotConversationEntity>,
  );
  return { service, repo, calls };
};

describe('ConversationGuardService', () => {
  it('get: conteo y silencio de la conversación (sin fila: limpio)', async () => {
    await expect(make(null).service.get(key)).resolves.toEqual({ strikes: 0, muted: false });
    await expect(
      make({ off_topic_strikes: 2, muted_at: new Date() }).service.get(key),
    ).resolves.toEqual({ strikes: 2, muted: true });
  });

  it('addStrike: suma en SQL (atómico) y devuelve el total', async () => {
    const h = make();
    await expect(h.service.addStrike(key)).resolves.toBe(2);
    const set = h.calls.find(([name]) => name === 'set')![1][0] as Record<string, () => string>;
    expect(set.off_topic_strikes()).toBe('off_topic_strikes + 1');
    expect(h.calls).toContainEqual([
      'where',
      [
        'company_id = :company AND channel = :channel AND chat_id = :chat',
        { company: '7', channel: 'whatsapp-web', chat: '57300@s.whatsapp.net' },
      ],
    ]);
  });

  it('resetStrikes: solo escribe si había conteo', async () => {
    const h = make();
    await h.service.resetStrikes(key);
    expect(h.calls).toContainEqual(['set', [{ off_topic_strikes: 0 }]]);
    expect(h.calls).toContainEqual(['andWhere', ['off_topic_strikes > 0']]);
  });

  it('mute / unmute', async () => {
    const h = make();
    await h.service.mute(key);
    await h.service.unmute(key);
    const where = { company_id: '7', channel: 'whatsapp-web', chat_id: '57300@s.whatsapp.net' };
    expect(h.repo.update).toHaveBeenNthCalledWith(1, where, {
      muted_at: expect.any(Date) as unknown,
    });
    expect(h.repo.update).toHaveBeenNthCalledWith(2, where, {
      muted_at: null,
      off_topic_strikes: 0,
    });
  });
});
