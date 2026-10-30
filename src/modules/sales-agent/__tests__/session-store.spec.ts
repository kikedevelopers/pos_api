import type { Repository } from 'typeorm';

import type { SalesBotConversationEntity } from '../entities/sales-bot-conversation.entity';
import { MAX_SESSION_TURNS, SESSION_TTL_MS, SellerSessionStore } from '../internal/session-store';

type Row = SalesBotConversationEntity;
type Where = { company_id: string; channel: string; chat_id: string };

const sameChat = (row: Row, where: Where): boolean =>
  row.company_id === where.company_id &&
  row.channel === where.channel &&
  row.chat_id === where.chat_id;

/**
 * Repositorio falso en memoria con la semántica que usa el store: findOne por
 * chat, create, save (sella `updated_at` como `@UpdateDateColumn`) y delete.
 * Devuelve COPIAS para detectar si el store olvida guardar.
 */
const makeRepo = () => {
  const rows: Row[] = [];
  const clone = (row: Row): Row => ({
    ...row,
    turns: [...row.turns],
    order_signatures: [...row.order_signatures],
  });
  const repo = {
    rows,
    findOne: jest.fn(async ({ where }: { where: Where }) => {
      const row = rows.find((r) => sameChat(r, where));
      return row ? clone(row) : null;
    }),
    create: jest.fn((partial: Partial<Row>) => ({ ...partial }) as Row),
    save: jest.fn(async (row: Row) => {
      const stored = { ...clone(row), updated_at: new Date(Date.now()) };
      const index = rows.findIndex((r) => sameChat(r, stored));
      if (index >= 0) {
        rows[index] = stored;
      } else {
        rows.push(stored);
      }
      return clone(stored);
    }),
    delete: jest.fn(async (where: Where) => {
      const index = rows.findIndex((r) => sameChat(r, where));
      if (index >= 0) {
        rows.splice(index, 1);
      }
    }),
  };
  return repo;
};

describe('SellerSessionStore', () => {
  let repo: ReturnType<typeof makeRepo>;
  let store: SellerSessionStore;
  const key = SellerSessionStore.key(7, 'telegram', '123');

  /** Simula que pasó `ms` desde la última actividad del chat. */
  const ageChat = (ms: number): void => {
    for (const row of repo.rows) {
      row.updated_at = new Date(row.updated_at.getTime() - ms);
    }
  };

  beforeEach(() => {
    repo = makeRepo();
    store = new SellerSessionStore(repo as unknown as Repository<Row>);
  });

  it('la clave identifica negocio, canal y chat', () => {
    expect(SellerSessionStore.key(7, 'whatsapp', '1')).toEqual({
      companyId: 7,
      channel: 'whatsapp',
      chatId: '1',
    });
  });

  it('empieza vacío y acumula turnos', async () => {
    await expect(store.history(key)).resolves.toEqual([]);
    await store.append(key, { role: 'user', content: 'hola' });
    const turns = await store.append(key, { role: 'assistant', content: '¡hola!' });
    expect(turns).toHaveLength(2);
    await expect(store.history(key)).resolves.toHaveLength(2);
  });

  it('persiste en BD: otra instancia (tras un reinicio) ve la misma conversación', async () => {
    await store.markDay(key, '2026-10-30');
    await store.append(key, { role: 'user', content: 'hola' });

    const afterRestart = new SellerSessionStore(repo as unknown as Repository<Row>);
    await expect(afterRestart.history(key)).resolves.toHaveLength(1);
    // Y no vuelve a contar como primer mensaje del día.
    await expect(afterRestart.markDay(key, '2026-10-30')).resolves.toBe(false);
  });

  it('guarda la fila con el negocio, el canal y el chat', async () => {
    await store.append(key, { role: 'user', content: 'hola' });
    expect(repo.rows[0]).toMatchObject({ company_id: '7', channel: 'telegram', chat_id: '123' });
  });

  it('recorta a MAX_SESSION_TURNS conservando los más recientes', async () => {
    for (let i = 0; i < MAX_SESSION_TURNS + 10; i += 1) {
      await store.append(key, { role: 'user', content: `m${i}` });
    }
    const turns = await store.history(key);
    expect(turns).toHaveLength(MAX_SESSION_TURNS);
    expect(turns[turns.length - 1].content).toBe(`m${MAX_SESSION_TURNS + 9}`);
  });

  it('rememberOrder deduplica: true la 1ª vez, false si se repite (doble cierre)', async () => {
    await store.append(key, { role: 'user', content: 'hola' });
    await expect(store.rememberOrder(key, 'sig-A')).resolves.toBe(true);
    await expect(store.rememberOrder(key, 'sig-A')).resolves.toBe(false);
    await expect(store.rememberOrder(key, 'sig-B')).resolves.toBe(true);
  });

  it('las firmas de pedidos sobreviven a nuevos turnos de la misma conversación', async () => {
    await store.append(key, { role: 'user', content: 'quiero 2 panes' });
    await store.rememberOrder(key, 'sig-A');
    await store.append(key, { role: 'assistant', content: 'listo' });
    await expect(store.rememberOrder(key, 'sig-A')).resolves.toBe(false);
  });

  it('reset olvida la conversación', async () => {
    await store.append(key, { role: 'user', content: 'hola' });
    await store.reset(key);
    await expect(store.history(key)).resolves.toEqual([]);
  });

  it('una conversación vencida no devuelve turnos', async () => {
    await store.append(key, { role: 'user', content: 'hola' });
    ageChat(SESSION_TTL_MS + 1);
    await expect(store.history(key)).resolves.toEqual([]);
  });

  it('al escribir tras vencer, empieza de cero (turnos y pedidos)', async () => {
    await store.append(key, { role: 'user', content: 'hola' });
    await store.rememberOrder(key, 'sig-A');
    ageChat(SESSION_TTL_MS + 1);

    await store.markDay(key, '2026-10-30');
    const turns = await store.append(key, { role: 'user', content: 'otra cosa' });

    expect(turns).toEqual([{ role: 'user', content: 'otra cosa' }]);
    await expect(store.rememberOrder(key, 'sig-A')).resolves.toBe(true);
  });

  it('cada chat lleva su propia conversación', async () => {
    const other = SellerSessionStore.key(7, 'telegram', '999');
    await store.append(key, { role: 'user', content: 'hola' });
    await expect(store.history(other)).resolves.toEqual([]);
  });

  it('el mismo chat en otro canal u otro negocio es otra conversación', async () => {
    await store.append(key, { role: 'user', content: 'hola' });
    await expect(store.history(SellerSessionStore.key(7, 'whatsapp', '123'))).resolves.toEqual([]);
    await expect(store.history(SellerSessionStore.key(8, 'telegram', '123'))).resolves.toEqual([]);
  });

  describe('markDay (primer mensaje del día)', () => {
    it('una conversación nueva es el primer mensaje del día', async () => {
      await expect(store.markDay(key, '2026-10-30')).resolves.toBe(true);
    });

    it('el segundo mensaje del mismo día ya no es el primero', async () => {
      await store.markDay(key, '2026-10-30');
      await store.append(key, { role: 'user', content: 'hola' });
      await expect(store.markDay(key, '2026-10-30')).resolves.toBe(false);
    });

    it('al cambiar de día vuelve a ser el primero, sin perder el historial', async () => {
      await store.markDay(key, '2026-10-30');
      await store.append(key, { role: 'user', content: 'hola' });
      await expect(store.markDay(key, '2026-10-31')).resolves.toBe(true);
      await expect(store.history(key)).resolves.toHaveLength(1);
    });

    it('append conserva el día marcado', async () => {
      await store.markDay(key, '2026-10-30');
      await store.append(key, { role: 'user', content: 'hola' });
      await store.append(key, { role: 'assistant', content: '¡hola!' });
      await expect(store.markDay(key, '2026-10-30')).resolves.toBe(false);
    });

    it('una pausa larga el MISMO día no vuelve a saludar (el día no vence)', async () => {
      await store.markDay(key, '2026-10-30');
      await store.append(key, { role: 'user', content: 'hola' });
      ageChat(SESSION_TTL_MS + 1);
      await expect(store.markDay(key, '2026-10-30')).resolves.toBe(false);
    });

    it('tras reset vuelve a ser el primero', async () => {
      await store.markDay(key, '2026-10-30');
      await store.reset(key);
      await expect(store.markDay(key, '2026-10-30')).resolves.toBe(true);
    });

    it('cada chat lleva su propio día', async () => {
      const other = SellerSessionStore.key(7, 'telegram', '999');
      await store.markDay(key, '2026-10-30');
      await expect(store.markDay(other, '2026-10-30')).resolves.toBe(true);
    });
  });
});
