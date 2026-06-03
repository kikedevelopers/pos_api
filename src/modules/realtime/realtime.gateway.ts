import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import type { JwtPayload } from '@/common/types/jwt-payload.type';

/**
 * Gateway de tiempo real (Socket.IO).
 *
 * Propósito: notificar a los clientes (POS / PWA / Electron) que la lista de
 * tickets cambió, para que invaliden su caché y refresquen. NO transporta el
 * detalle de la venta — solo una señal con metadatos mínimos.
 *
 * Reutiliza el MISMO servidor HTTP/puerto que la API (no abre puerto aparte):
 * el `IoAdapter` por defecto se adjunta al servidor de Nest. El path por
 * defecto `/socket.io/` queda activo (el edge nginx lo enruta con upgrade WS).
 *
 * Multi-tenant: el `companyId` SIEMPRE proviene del JWT verificado en el
 * handshake — jamás del cliente vía query/body. Los rooms están namespaced por
 * company, de modo que un emit nunca cruza tenants.
 *
 * CORS: `origin: true` (reflejar el origin) + `credentials: false`. El auth va
 * por token explícito en el handshake (`auth.token` o header Authorization),
 * NO por cookies, así que no necesitamos credenciales. El cliente Electron
 * envía Origin no-estándar y reflejarlo es correcto aquí.
 */
@WebSocketGateway({ cors: { origin: true, credentials: false } })
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  private readonly server!: Server;

  private readonly jwtSecret: string;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    // Mismo secret que la auth HTTP (`JwtStrategy` / `JwtIssuerService`).
    this.jwtSecret = configService.getOrThrow<string>('JWT_SECRET');
  }

  /**
   * Handshake: valida el JWT con el MISMO secret que la auth HTTP. Si el token
   * falta, es inválido, expiró o no tiene `company_id` (salvo superadmin), se
   * desconecta el socket. Tras validar, une el socket a sus rooms.
   */
  handleConnection(client: Socket): void {
    const token = this.extractToken(client);
    if (token === null) {
      client.disconnect();
      return;
    }

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(token, { secret: this.jwtSecret });
    } catch {
      client.disconnect();
      return;
    }

    const userId = payload.user_id;
    const companyId = payload.company_id;
    const type = payload.type;

    // Validación de forma mínima: el resto del contrato lo garantiza el emisor
    // del token (mismo `JwtIssuerService` que la API). Sin `company_id` válido
    // (salvo superadmin) no hay tenant al cual unir el socket → desconectar.
    if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) {
      client.disconnect();
      return;
    }
    if (type !== 'superadmin' && (typeof companyId !== 'number' || companyId <= 0)) {
      client.disconnect();
      return;
    }

    // superadmin sin company_id no se une a ningún room de tenant (no recibe
    // notificaciones de ticket; las consume vía endpoints cross-tenant si hace
    // falta). Conexión permitida, pero sin rooms de company.
    if (typeof companyId !== 'number' || companyId <= 0) {
      return;
    }

    // SIEMPRE: room propio del usuario dentro de su company.
    void client.join(this.userRoom(companyId, userId));

    // No-employee (owner/manager/superadmin con company): ve TODOS los tickets
    // de la company → room agregado.
    if (type !== 'employee') {
      void client.join(this.allRoom(companyId));
    }
  }

  /**
   * Emite `ticket:changed` a los interesados de una company:
   *   - room agregado `company:<id>:all` (owner/manager).
   *   - room del seller `company:<id>:user:<sellerId>` (el employee creador).
   *
   * Best-effort: el llamador debe envolver en try/catch para que un fallo de
   * socket NUNCA rompa la operación de negocio (creación de venta, etc.).
   *
   * @param companyId company del JWT del actor (nunca del cliente).
   * @param sellerId  user_id del creador/actor de la venta.
   * @param payload   señal mínima para invalidar la lista en el cliente.
   */
  emitTicketChanged(companyId: number, sellerId: number, payload: TicketChangedPayload = {}): void {
    const body: TicketChangedPayload = { companyId, sellerId, ...payload };
    this.server
      .to(this.allRoom(companyId))
      .to(this.userRoom(companyId, sellerId))
      .emit(TICKET_CHANGED_EVENT, body);
  }

  private extractToken(client: Socket): string | null {
    // `handshake.auth` es `{ [key: string]: any }` en los typings de socket.io;
    // tipamos el acceso para evitar propagar `any` (no-unsafe-assignment).
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    const authToken = auth?.token;
    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken;
    }
    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const raw = header.slice('Bearer '.length).trim();
      return raw.length > 0 ? raw : null;
    }
    return null;
  }

  private userRoom(companyId: number, userId: number): string {
    return `company:${companyId}:user:${userId}`;
  }

  private allRoom(companyId: number): string {
    return `company:${companyId}:all`;
  }
}

/** Evento único de invalidación de lista de tickets. */
export const TICKET_CHANGED_EVENT = 'ticket:changed';

/**
 * Señal mínima. El cliente solo la usa para invalidar/refrescar su lista; no
 * transporta el aggregate de la venta (eso lo trae `GET /sales/:id`).
 */
export interface TicketChangedPayload {
  companyId?: number;
  sellerId?: number;
  invoiceId?: number;
  ticketNumber?: string | number;
}
