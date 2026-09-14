/**
 * Estado de activación de una cuenta, tal como lo pinta el panel superadmin.
 * Puro y testeado: de aquí sale lo que el operador ve y decide si aparece el
 * botón de reenviar el correo.
 */

export type ActivationStatus =
  /** La cuenta ya confirmó su correo: puede entrar. */
  | 'active'
  /** Sin activar, con un enlace vigente: falta que el dueño lo pulse. */
  | 'pending'
  /** Sin activar y el enlace venció: hay que reenviarlo. */
  | 'expired'
  /** Sin activar y sin ningún enlace vivo (reemitido, consumido o cuenta vieja). */
  | 'no_link';

export interface ActivationSnapshot {
  status: ActivationStatus;
  /** Cuándo se activó. `null` si todavía no. */
  activatedAt: string | null;
  /** Vencimiento del último enlace emitido. `null` si no hay ninguno. */
  linkExpiresAt: string | null;
  /**
   * `true` cuando el operador puede resolverlo reenviando el correo. Es lo que
   * decide si el panel muestra el botón: un enlace vigente NO se reenvía, que
   * solo invalidaría el que el dueño quizá está a punto de pulsar.
   */
  canResend: boolean;
}

/** Lo mínimo que se sabe del último token emitido para un usuario. */
export interface LatestActivationToken {
  expires_at: Date;
  used_at: Date | null;
}

/**
 * Deriva el estado a partir de la fecha de activación y del último token.
 *
 * `now` se inyecta para poder probar el vencimiento sin tocar el reloj.
 */
export const resolveActivationStatus = (
  activatedAt: Date | null,
  latestToken: LatestActivationToken | null,
  now: Date,
): ActivationSnapshot => {
  if (activatedAt) {
    return {
      status: 'active',
      activatedAt: activatedAt.toISOString(),
      linkExpiresAt: null,
      canResend: false,
    };
  }

  // Sin token, o con uno ya canjeado y la cuenta aún sin activar: no hay nada
  // que el dueño pueda pulsar, así que el reenvío es la única salida.
  if (!latestToken || latestToken.used_at !== null) {
    return { status: 'no_link', activatedAt: null, linkExpiresAt: null, canResend: true };
  }

  const expiresAt = latestToken.expires_at;
  if (expiresAt.getTime() <= now.getTime()) {
    return {
      status: 'expired',
      activatedAt: null,
      linkExpiresAt: expiresAt.toISOString(),
      canResend: true,
    };
  }

  return {
    status: 'pending',
    activatedAt: null,
    linkExpiresAt: expiresAt.toISOString(),
    canResend: false,
  };
};

/**
 * Explicación para el operador. Es lo que se lee al pasar el cursor por encima
 * del estado, así que dice el motivo Y qué se puede hacer.
 */
export const describeActivationStatus = (snapshot: ActivationSnapshot): string => {
  switch (snapshot.status) {
    case 'active':
      return 'El dueño confirmó su correo y puede iniciar sesión.';
    case 'pending':
      return 'Le enviamos el correo de activación y todavía no lo abre. El enlace sigue vigente.';
    case 'expired':
      return 'El enlace de activación venció sin usarse. No puede iniciar sesión hasta reenviarlo.';
    default:
      return 'No tiene ningún enlace de activación vigente. No puede iniciar sesión hasta reenviarlo.';
  }
};
