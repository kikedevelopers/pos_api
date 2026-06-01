import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { AppConfig } from '@/config/app.config';

/**
 * Request de Express con el `rawBody` (Buffer) que expone
 * `NestFactory.create(..., { rawBody: true })`. Es el cuerpo SIN re-serializar,
 * imprescindible para reproducir el hash que firmó el navegador.
 */
type RequestWithRawBody = Request & { rawBody?: Buffer };

/**
 * Verifica la firma Ed25519 de las requests a `/superadmin/*` emitidas por el
 * panel kdevs-admin. Usa un PAR DEDICADO (`SUPERADMIN_SIGNING_PUBLIC_KEY`),
 * distinto del de `AdminSignatureGuard` (migration-import / `/admin/*`).
 *
 * El cliente firma con su clave privada (que vive SOLO en el navegador) el
 * mensaje canónico:
 *
 *     `${METHOD}\n${ORIGINAL_URL}\n${TIMESTAMP_MS}\n${SHA256_HEX_DEL_BODY}`
 *
 * y envía:
 *   - `x-kdevs-signature`  → firma en base64
 *   - `x-kdevs-timestamp`  → epoch ms (ventana anti-replay)
 *   - `x-kdevs-key-id`     → identificador de la clave (informativo / rotación)
 *
 * DIFERENCIA CLAVE vs `AdminSignatureGuard`: este guard hashea el BODY REAL
 * (`req.rawBody`). Así los GET/DELETE (sin cuerpo) hashean el buffer vacío y los
 * PATCH hashean el cuerpo EXACTO que firmó el navegador. El endpoint debe ir
 * `@Public()` para saltarse `JwtAuthGuard`/`SubscriptionGuard` globales.
 */
@Injectable()
export class SuperadminSignatureGuard implements CanActivate {
  private readonly logger = new Logger(SuperadminSignatureGuard.name);
  private readonly publicKey: KeyObject | null;
  private readonly maxSkewMs: number;

  constructor(private readonly configService: ConfigService) {
    const appConfig = this.configService.getOrThrow<AppConfig>('app');
    this.maxSkewMs = appConfig.adminSigning.superadminMaxSkewMs;
    this.publicKey = SuperadminSignatureGuard.loadPublicKey(
      appConfig.adminSigning.superadminPublicKey,
    );
  }

  private static loadPublicKey(base64Spki: string): KeyObject | null {
    if (!base64Spki) {
      return null;
    }
    try {
      return createPublicKey({
        key: Buffer.from(base64Spki, 'base64'),
        format: 'der',
        type: 'spki',
      });
    } catch {
      return null;
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.publicKey) {
      throw new ServiceUnavailableException(
        'Firma superadmin no configurada (SUPERADMIN_SIGNING_PUBLIC_KEY).',
      );
    }

    const req = context.switchToHttp().getRequest<RequestWithRawBody>();
    const signature = req.header('x-kdevs-signature');
    const timestamp = req.header('x-kdevs-timestamp');

    if (!signature || !timestamp) {
      throw new UnauthorizedException('Firma o timestamp ausentes.');
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.maxSkewMs) {
      throw new UnauthorizedException('Firma expirada o timestamp inválido.');
    }

    const method = req.method.toUpperCase();
    const path = req.originalUrl;
    // Hash del BODY REAL: GET/DELETE (sin cuerpo) hashean Buffer vacío; PATCH
    // hashea el cuerpo exacto que firmó el navegador.
    const raw = req.rawBody;
    // Endurecimiento: en métodos con cuerpo exigimos `rawBody` presente. Tratar
    // "ausente" como "vacío" permitiría aceptar una firma de body vacío junto a
    // un body real si el parser no poblara rawBody (Content-Type ausente, etc.).
    if ((method === 'PATCH' || method === 'POST' || method === 'PUT') && raw === undefined) {
      throw new UnauthorizedException('Cuerpo ausente en método con body.');
    }
    const bodyHash = createHash('sha256')
      .update(raw ?? Buffer.alloc(0))
      .digest('hex');
    const message = `${method}\n${path}\n${ts}\n${bodyHash}`;

    let valid = false;
    try {
      valid = verify(
        null,
        Buffer.from(message, 'utf8'),
        this.publicKey,
        Buffer.from(signature, 'base64'),
      );
    } catch (e) {
      this.logger.warn(`Error verificando firma superadmin: ${(e as Error).message}`);
      valid = false;
    }

    if (!valid) {
      throw new UnauthorizedException('Firma inválida.');
    }

    return true;
  }
}
