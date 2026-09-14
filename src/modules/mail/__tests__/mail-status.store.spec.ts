import { MailStatusStore, resolveMailStatusLevel } from '../internal/mail-status.store';

const AT = (iso: string): Date => new Date(iso);

describe('MailStatusStore', () => {
  it('arranca en cero', () => {
    expect(new MailStatusStore().snapshot()).toEqual({
      sentCount: 0,
      failedCount: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
    });
  });

  it('cuenta los envíos buenos y guarda el momento', () => {
    const store = new MailStatusStore();
    store.recordSuccess(AT('2026-08-12T14:00:00.000Z'));
    store.recordSuccess(AT('2026-08-12T14:05:00.000Z'));
    const snap = store.snapshot();
    expect(snap.sentCount).toBe(2);
    expect(snap.lastSuccessAt).toBe('2026-08-12T14:05:00.000Z');
    expect(snap.failedCount).toBe(0);
  });

  it('cuenta los fallos y guarda el último mensaje', () => {
    const store = new MailStatusStore();
    store.recordFailure('primero', AT('2026-08-12T14:00:00.000Z'));
    store.recordFailure('segundo', AT('2026-08-12T14:01:00.000Z'));
    const snap = store.snapshot();
    expect(snap.failedCount).toBe(2);
    expect(snap.consecutiveFailures).toBe(2);
    expect(snap.lastErrorMessage).toBe('segundo');
    expect(snap.lastErrorAt).toBe('2026-08-12T14:01:00.000Z');
  });

  it('un envío bueno corta la racha de fallos pero conserva el histórico', () => {
    // Distinguir "está roto ahora" de "se rompió alguna vez" es todo el punto
    // del contador consecutivo.
    const store = new MailStatusStore();
    store.recordFailure('boom');
    store.recordFailure('boom');
    store.recordSuccess();
    const snap = store.snapshot();
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.failedCount).toBe(2);
    expect(snap.lastErrorMessage).toBe('boom');
  });

  it('snapshot devuelve una copia, no el estado interno', () => {
    const store = new MailStatusStore();
    const snap = store.snapshot();
    snap.sentCount = 99;
    expect(store.snapshot().sentCount).toBe(0);
  });

  it('reset vuelve a cero', () => {
    const store = new MailStatusStore();
    store.recordSuccess();
    store.recordFailure('x');
    store.reset();
    expect(store.snapshot().sentCount).toBe(0);
    expect(store.snapshot().lastErrorMessage).toBeNull();
  });
});

describe('resolveMailStatusLevel', () => {
  type Activity = ReturnType<MailStatusStore['snapshot']>;
  const activity = (patch: Partial<Activity> = {}): Activity => ({
    sentCount: 0,
    failedCount: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    consecutiveFailures: 0,
    ...patch,
  });

  it('sin credenciales → deshabilitado', () => {
    const result = resolveMailStatusLevel({
      configured: false,
      healthy: false,
      driver: 'resend',
      activity: activity(),
    });
    expect(result.level).toBe('disabled');
    expect(result.summary).toContain('Sin credenciales');
  });

  it('driver log → advertencia, aunque esté sano', () => {
    // Verde aquí sería mentira: en modo log NO sale ningún correo.
    const result = resolveMailStatusLevel({
      configured: true,
      healthy: true,
      driver: 'log',
      activity: activity(),
    });
    expect(result.level).toBe('warning');
    expect(result.summary).toContain('no se envían');
  });

  it('proveedor caído → error', () => {
    const result = resolveMailStatusLevel({
      configured: true,
      healthy: false,
      driver: 'resend',
      activity: activity(),
    });
    expect(result.level).toBe('error');
  });

  it('credenciales buenas pero envíos fallando → error', () => {
    // El caso traicionero: `verify()` pasa (la llave sirve) y aun así ningún
    // correo llega, p. ej. con el dominio sin verificar.
    const result = resolveMailStatusLevel({
      configured: true,
      healthy: true,
      driver: 'resend',
      activity: activity({ consecutiveFailures: 1, failedCount: 1 }),
    });
    expect(result.level).toBe('error');
    expect(result.summary).toBe('El último correo no se pudo enviar.');
  });

  it('pluraliza la racha de fallos', () => {
    const result = resolveMailStatusLevel({
      configured: true,
      healthy: true,
      driver: 'resend',
      activity: activity({ consecutiveFailures: 3, failedCount: 3 }),
    });
    expect(result.summary).toBe('Los últimos 3 correos no se pudieron enviar.');
  });

  it('fallos ya superados → advertencia, no error', () => {
    const result = resolveMailStatusLevel({
      configured: true,
      healthy: true,
      driver: 'resend',
      activity: activity({ sentCount: 10, failedCount: 2, consecutiveFailures: 0 }),
    });
    expect(result.level).toBe('warning');
    expect(result.summary).toContain('2 fallo(s) anteriores');
  });

  it('todo en orden → ok', () => {
    const result = resolveMailStatusLevel({
      configured: true,
      healthy: true,
      driver: 'resend',
      activity: activity({ sentCount: 5 }),
    });
    expect(result.level).toBe('ok');
    expect(result.summary).toContain('Operativo');
  });

  it('sin credenciales manda sobre cualquier otra señal', () => {
    const result = resolveMailStatusLevel({
      configured: false,
      healthy: true,
      driver: 'log',
      activity: activity({ sentCount: 100 }),
    });
    expect(result.level).toBe('disabled');
  });
});
