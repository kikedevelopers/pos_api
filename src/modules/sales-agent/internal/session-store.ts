import { Injectable } from '@nestjs/common';

import type { ChatTurn } from '@/modules/ai/internal/gemini.types';

/**
 * Memoria de conversación por chat, EN MEMORIA. Suficiente para esta v1 ("miremos
 * cómo funciona"): se pierde al reiniciar el servidor. Está detrás de una clase
 * inyectable para poder cambiarla luego por una tabla sin tocar al agente.
 *
 * Cada sesión guarda los turnos del cliente y del vendedor (texto), acotados por
 * cantidad y por tiempo para no crecer sin límite ni arrastrar charlas viejas.
 */
export interface SessionData {
  turns: ChatTurn[];
  updatedAt: number;
  /** Firmas de pedidos ya cerrados en esta sesión (red anti doble cierre). */
  orderSignatures: Set<string>;
}

/** Turnos máximos que se recuerdan por chat (cliente + vendedor). */
export const MAX_SESSION_TURNS = 40;

/** Una sesión inactiva por más de esto se descarta (6 horas). */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class SellerSessionStore {
  private readonly sessions = new Map<string, SessionData>();

  /** Clave estable por canal + chat (no colisiona entre Telegram y WhatsApp). */
  static key(channel: string, chatId: string): string {
    return `${channel}:${chatId}`;
  }

  /** Turnos vigentes de la sesión (vacío si no existe o expiró). */
  history(key: string): ChatTurn[] {
    const session = this.sessions.get(key);
    if (!session) return [];
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
      this.sessions.delete(key);
      return [];
    }
    return session.turns;
  }

  /** Agrega un turno y devuelve el historial ya recortado. */
  append(key: string, turn: ChatTurn): ChatTurn[] {
    const existingSession = this.sessions.get(key);
    const existing = this.history(key);
    const turns = [...existing, turn].slice(-MAX_SESSION_TURNS);
    this.sessions.set(key, {
      turns,
      updatedAt: Date.now(),
      // Conserva las firmas de pedidos mientras la sesión siga viva.
      orderSignatures: existing.length > 0 ? (existingSession?.orderSignatures ?? new Set()) : new Set(),
    });
    return turns;
  }

  /**
   * Registra un pedido cerrado. Devuelve `true` la PRIMERA vez que se ve esa
   * firma en la sesión y `false` si ya se había cerrado (doble cierre del
   * modelo) — el canal usa esto para no avisarle dos veces al dueño.
   */
  rememberOrder(key: string, signature: string): boolean {
    const session = this.sessions.get(key);
    if (!session) {
      this.sessions.set(key, {
        turns: [],
        updatedAt: Date.now(),
        orderSignatures: new Set([signature]),
      });
      return true;
    }
    if (session.orderSignatures.has(signature)) return false;
    session.orderSignatures.add(signature);
    return true;
  }

  /** Olvida la conversación (p. ej. el cliente escribió /reiniciar). */
  reset(key: string): void {
    this.sessions.delete(key);
  }

  /** Limpieza perezosa de sesiones vencidas; la llama el poller de vez en cuando. */
  pruneExpired(now: number = Date.now()): void {
    for (const [key, session] of this.sessions) {
      if (now - session.updatedAt > SESSION_TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }
}
