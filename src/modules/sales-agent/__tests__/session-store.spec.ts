import {
  MAX_SESSION_TURNS,
  SESSION_TTL_MS,
  SellerSessionStore,
} from '../internal/session-store';

describe('SellerSessionStore', () => {
  let store: SellerSessionStore;
  const key = SellerSessionStore.key('telegram', '123');

  beforeEach(() => {
    store = new SellerSessionStore();
  });

  it('la clave separa canales y chats', () => {
    expect(SellerSessionStore.key('telegram', '1')).toBe('telegram:1');
    expect(SellerSessionStore.key('whatsapp', '1')).toBe('whatsapp:1');
  });

  it('empieza vacío y acumula turnos', () => {
    expect(store.history(key)).toEqual([]);
    store.append(key, { role: 'user', content: 'hola' });
    const turns = store.append(key, { role: 'assistant', content: '¡hola!' });
    expect(turns).toHaveLength(2);
    expect(store.history(key)).toHaveLength(2);
  });

  it('recorta a MAX_SESSION_TURNS conservando los más recientes', () => {
    for (let i = 0; i < MAX_SESSION_TURNS + 10; i += 1) {
      store.append(key, { role: 'user', content: `m${i}` });
    }
    const turns = store.history(key);
    expect(turns).toHaveLength(MAX_SESSION_TURNS);
    expect(turns[turns.length - 1].content).toBe(`m${MAX_SESSION_TURNS + 9}`);
  });

  it('rememberOrder deduplica: true la 1ª vez, false si se repite (doble cierre)', () => {
    store.append(key, { role: 'user', content: 'hola' });
    expect(store.rememberOrder(key, 'sig-A')).toBe(true);
    expect(store.rememberOrder(key, 'sig-A')).toBe(false);
    expect(store.rememberOrder(key, 'sig-B')).toBe(true);
  });

  it('las firmas de pedidos sobreviven a nuevos turnos de la misma sesión', () => {
    store.append(key, { role: 'user', content: 'quiero 2 panes' });
    store.rememberOrder(key, 'sig-A');
    store.append(key, { role: 'assistant', content: 'listo' });
    // Tras otro turno, el mismo pedido sigue marcado como visto.
    expect(store.rememberOrder(key, 'sig-A')).toBe(false);
  });

  it('reset olvida la conversación', () => {
    store.append(key, { role: 'user', content: 'hola' });
    store.reset(key);
    expect(store.history(key)).toEqual([]);
  });

  it('una sesión vencida se descarta al leerla', () => {
    store.append(key, { role: 'user', content: 'hola' });
    const future = Date.now() + SESSION_TTL_MS + 1;
    jest.spyOn(Date, 'now').mockReturnValue(future);
    expect(store.history(key)).toEqual([]);
    jest.restoreAllMocks();
  });

  it('pruneExpired limpia las sesiones vencidas', () => {
    store.append(key, { role: 'user', content: 'hola' });
    store.pruneExpired(Date.now() + SESSION_TTL_MS + 1);
    // Tras la poda, al volver a leer no hay nada.
    expect(store.history(key)).toEqual([]);
  });
});
