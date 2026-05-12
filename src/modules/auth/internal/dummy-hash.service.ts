import { Injectable, type OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';

/**
 * Provee un hash argon2id precomputado al arrancar. Cuando el login no
 * encuentra al user, hacemos un `argon2.verify` contra este hash para que el
 * tiempo de respuesta sea estadísticamente indistinguible del caso "user
 * existe pero password mal". Evita enumeración de emails por timing
 * side-channel.
 *
 * Se modela como servicio (no constante de módulo) porque el cómputo del
 * hash es asíncrono y solo está disponible después de `onModuleInit`. La
 * verificación se hace consultando `get()` — si por alguna razón un caller
 * lo invoca antes del init, lanza un error explícito en vez de devolver
 * cadena vacía (que pasaría `argon2.verify` con `false` silenciosamente).
 */
@Injectable()
export class DummyHashService implements OnModuleInit {
  private hash: string | null = null;

  async onModuleInit(): Promise<void> {
    // Una sola vez al arrancar. ~30-60ms en CPU moderna; aceptable.
    this.hash = await argon2.hash('dummy-password-for-timing-constant-login', ARGON2_OPTIONS);
  }

  get(): string {
    if (this.hash === null) {
      // Defensa programática: nunca debería ocurrir si el módulo está
      // correctamente inicializado.
      throw new Error('DummyHashService no inicializado');
    }
    return this.hash;
  }
}
