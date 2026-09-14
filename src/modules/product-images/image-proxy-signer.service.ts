import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ProductImagesConfig } from '@/config/product-images.config';

import {
  buildImageProxyPath,
  signImageObject,
  verifyImageObject,
  type ImageTokenVerification,
} from './internal/image-proxy-url';

/**
 * Firma y verifica las URLs del proxy de imágenes. El secreto es `JWT_SECRET`
 * (ya garantizado por el esquema de validación; es un secreto fuerte del
 * servidor). La vigencia reusa `signedUrlTtlSeconds` de la config de imágenes,
 * el mismo parámetro que regía las URLs firmadas de GCS.
 */
@Injectable()
export class ImageProxySigner {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(configService: ConfigService) {
    this.secret = configService.getOrThrow<string>('JWT_SECRET');
    this.ttlSeconds = configService.getOrThrow<ProductImagesConfig>('productImages')
      .signedUrlTtlSeconds;
  }

  /** URL (relativa) del proxy para servir `objectName`, vigente `ttlSeconds`. */
  buildUrl(objectName: string): string {
    const expiresAtMs = Date.now() + this.ttlSeconds * 1000;
    const signature = signImageObject(objectName, expiresAtMs, this.secret);
    return buildImageProxyPath(objectName, expiresAtMs, signature);
  }

  /** Verifica una URL firmada recibida en el endpoint de servido. */
  verify(objectName: string, expiresAtMs: number, signature: string): ImageTokenVerification {
    return verifyImageObject({
      objectName,
      expiresAtMs,
      signature,
      secret: this.secret,
      nowMs: Date.now(),
    });
  }
}
