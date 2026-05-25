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
 * Verifica la firma Ed25519 de requests a endpoints `/admin/*` emitidos por
 * paneles externos (kdevs-admin y futuras apps), en lugar de un login JWT.
 *
 * El cliente firma con su clave privada el mensaje canónico:
 *
 *     `${METHOD}\n${PATH_CON_QUERY}\n${TIMESTAMP_MS}\n${SHA256_HEX_DEL_BODY}`
 *
 * y envía:
 *   - `x-kdevs-signature`  → firma en base64
 *   - `x-kdevs-timestamp`  → epoch ms (ventana anti-replay)
 *   - `x-kdevs-key-id`     → identificador de la clave (informativo / futura
 *                            rotación multi-clave)
 *
 * Aquí reconstruimos el mensaje y verificamos con la clave pública configurada
 * (`ADMIN_SIGNING_PUBLIC_KEY`, SPKI en base64). El endpoint debe marcarse
 * `@Public()` para saltarse el `JwtAuthGuard` global.
 */
@Injectable()
export class AdminSignatureGuard implements CanActivate {
  private readonly logger = new Logger(AdminSignatureGuard.name);
  private readonly publicKey: KeyObject | null;
  private readonly maxSkewMs: number;

  constructor(private readonly configService: ConfigService) {
    const appConfig = this.configService.getOrThrow<AppConfig>('app');
    this.maxSkewMs = appConfig.adminSigning.maxSkewMs;
    this.publicKey = AdminSignatureGuard.loadPublicKey(appConfig.adminSigning.publicKey);
  }

  private static loadPublicKey(base64Spki: string): KeyObject | null {
    if (!base64Spki) return null;
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
        'Firma admin no configurada (ADMIN_SIGNING_PUBLIC_KEY).',
      );
    }

    const req = context.switchToHttp().getRequest<Request>();
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
    // Solo se firman GET por ahora (lectura). El hash del body es el de cadena
    // vacía; para métodos con cuerpo habría que firmar el raw body.
    const bodyHash = createHash('sha256').update('').digest('hex');
    const message = `${method}\n${path}\n${ts}\n${bodyHash}`;

    let valid = false;
    try {
      valid = verify(null, Buffer.from(message, 'utf8'), this.publicKey, Buffer.from(signature, 'base64'));
    } catch (e) {
      this.logger.warn(`Error verificando firma admin: ${(e as Error).message}`);
      valid = false;
    }

    if (!valid) {
      throw new UnauthorizedException('Firma inválida.');
    }

    return true;
  }
}
