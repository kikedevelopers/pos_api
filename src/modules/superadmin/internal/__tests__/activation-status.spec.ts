import { describeActivationStatus, resolveActivationStatus } from '../activation-status';

const NOW = new Date('2026-08-12T10:00:00.000Z');
const FUTURE = new Date('2026-08-19T10:00:00.000Z');
const PAST = new Date('2026-08-05T10:00:00.000Z');
const ACTIVATED = new Date('2026-08-10T09:00:00.000Z');

describe('resolveActivationStatus', () => {
  it('una cuenta activada es `active` y no ofrece reenvío', () => {
    const snapshot = resolveActivationStatus(ACTIVATED, null, NOW);
    expect(snapshot).toEqual({
      status: 'active',
      activatedAt: ACTIVATED.toISOString(),
      linkExpiresAt: null,
      canResend: false,
    });
  });

  it('la activación manda aunque quede un token suelto', () => {
    // Puede pasar tras reemitir y activar por el enlace viejo: el estado real
    // es que la cuenta entra, no que hay un token por ahí.
    const snapshot = resolveActivationStatus(ACTIVATED, { expires_at: PAST, used_at: null }, NOW);
    expect(snapshot.status).toBe('active');
    expect(snapshot.canResend).toBe(false);
  });

  it('con un enlace vigente sin usar queda `pending` y NO se reenvía', () => {
    // Reenviar aquí invalidaría el enlace que el dueño quizá está a punto de
    // pulsar: se le rompería el que tiene abierto en el correo.
    const snapshot = resolveActivationStatus(null, { expires_at: FUTURE, used_at: null }, NOW);
    expect(snapshot).toEqual({
      status: 'pending',
      activatedAt: null,
      linkExpiresAt: FUTURE.toISOString(),
      canResend: false,
    });
  });

  it('con el enlace vencido queda `expired` y sí se reenvía', () => {
    const snapshot = resolveActivationStatus(null, { expires_at: PAST, used_at: null }, NOW);
    expect(snapshot).toEqual({
      status: 'expired',
      activatedAt: null,
      linkExpiresAt: PAST.toISOString(),
      canResend: true,
    });
  });

  it('vencer JUSTO ahora ya cuenta como vencido', () => {
    expect(resolveActivationStatus(null, { expires_at: NOW, used_at: null }, NOW).status).toBe(
      'expired',
    );
  });

  it('sin ningún token queda `no_link` y se reenvía', () => {
    const snapshot = resolveActivationStatus(null, null, NOW);
    expect(snapshot.status).toBe('no_link');
    expect(snapshot.canResend).toBe(true);
    expect(snapshot.linkExpiresAt).toBeNull();
  });

  it('un token ya canjeado con la cuenta sin activar también es `no_link`', () => {
    // No hay nada que el dueño pueda pulsar: el enlace ya se quemó.
    const snapshot = resolveActivationStatus(null, { expires_at: FUTURE, used_at: NOW }, NOW);
    expect(snapshot.status).toBe('no_link');
    expect(snapshot.canResend).toBe(true);
  });
});

describe('describeActivationStatus', () => {
  it('explica cada estado y, si toca, que hay que reenviar', () => {
    const build = (
      activatedAt: Date | null,
      token: { expires_at: Date; used_at: Date | null } | null,
    ) => describeActivationStatus(resolveActivationStatus(activatedAt, token, NOW));

    expect(build(ACTIVATED, null)).toContain('puede iniciar sesión');
    expect(build(null, { expires_at: FUTURE, used_at: null })).toContain('todavía no lo abre');
    expect(build(null, { expires_at: PAST, used_at: null })).toContain('venció');
    expect(build(null, null)).toContain('reenviarlo');
  });

  it('todos los motivos son distintos entre sí', () => {
    // Si dos estados dijeran lo mismo, el tooltip dejaría de servir para nada.
    const messages = [
      describeActivationStatus(resolveActivationStatus(ACTIVATED, null, NOW)),
      describeActivationStatus(
        resolveActivationStatus(null, { expires_at: FUTURE, used_at: null }, NOW),
      ),
      describeActivationStatus(
        resolveActivationStatus(null, { expires_at: PAST, used_at: null }, NOW),
      ),
      describeActivationStatus(resolveActivationStatus(null, null, NOW)),
    ];
    expect(new Set(messages).size).toBe(4);
  });
});
