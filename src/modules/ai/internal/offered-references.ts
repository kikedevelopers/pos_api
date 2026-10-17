/**
 * Referencias (ids de producto y de cliente) que `prepare_sale` le OFRECIÓ al
 * modelo dentro de una petición de chat.
 *
 * Por qué existe: el historial que viaja entre turnos es texto plano; el
 * modelo NO conserva los ids que la herramienta le devolvió en un turno
 * anterior. En el turno siguiente los "recuerda" — es decir, los inventa — y
 * un id inventado puede coincidir con OTRO producto real del negocio. Por eso
 * un id solo vale si la herramienta lo ofreció en ESTA misma petición (el
 * modelo puede reintentar con él en la misma respuesta); entre turnos, el
 * usuario elige por nombre y el modelo manda el nombre exacto.
 *
 * En memoria a propósito: una petición de chat vive en un solo proceso y dura
 * segundos. Se poda por antigüedad y por tamaño para no crecer sin fin.
 */

export type ReferenceKind = 'product' | 'customer';

/** Vigencia de lo ofrecido en una petición (una respuesta dura segundos). */
export const OFFERED_REFERENCES_TTL_MS = 10 * 60 * 1000;

/** Tope de peticiones recordadas a la vez. */
export const MAX_TRACKED_REQUESTS = 2000;

interface Entry {
  at: number;
  product: Set<number>;
  customer: Set<number>;
}

export class OfferedReferences {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  remember(request_id: string, kind: ReferenceKind, ids: Iterable<number>): void {
    this.prune();
    const entry = this.entries.get(request_id) ?? {
      at: this.now(),
      product: new Set<number>(),
      customer: new Set<number>(),
    };
    for (const id of ids) {
      entry[kind].add(id);
    }
    this.entries.set(request_id, entry);
  }

  wasOffered(request_id: string, kind: ReferenceKind, id: number): boolean {
    const entry = this.entries.get(request_id);
    if (!entry || this.now() - entry.at > OFFERED_REFERENCES_TTL_MS) {
      return false;
    }
    return entry[kind].has(id);
  }

  private prune(): void {
    const limit = this.now() - OFFERED_REFERENCES_TTL_MS;
    for (const [request_id, entry] of this.entries) {
      if (entry.at < limit) {
        this.entries.delete(request_id);
      }
    }
    // Map conserva el orden de inserción: los primeros son los más viejos.
    while (this.entries.size >= MAX_TRACKED_REQUESTS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}
