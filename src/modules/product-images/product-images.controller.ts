import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '@/common/decorators/public.decorator';

import { ImageProxySigner } from './image-proxy-signer.service';
import { ProductImageStorageService } from './product-image-storage.service';

/** Content-Type según la extensión del objeto (jpg/png/webp). */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function contentTypeForObject(objectName: string): string {
  const ext = objectName.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Proxy de imágenes del inventario.
 *
 * Sirve el binario de un objeto de GCS al navegador SIN URLs firmadas de Google:
 * firmar v4 con ADC exige la API `iam.signBlob`, deshabilitada en el proyecto de
 * despliegue. En su lugar, las URLs las firma pos_api (HMAC, ver
 * {@link ImageProxySigner}) y este endpoint las verifica y hace stream del
 * objeto usando el permiso de LECTURA que la SA ya tiene.
 *
 * Es `@Public()` (sin JWT) A PROPÓSITO: se carga desde un `<img src>`, que no
 * manda cabecera Authorization. La FIRMA es la autorización — una URL-capacidad
 * acotada al objeto y al tiempo, imposible de forjar sin el secreto del servidor,
 * exactamente como una URL firmada de GCS.
 */
@ApiTags('product-images')
@Controller('product-images')
export class ProductImagesController {
  private readonly logger = new Logger(ProductImagesController.name);

  constructor(
    private readonly storage: ProductImageStorageService,
    private readonly signer: ImageProxySigner,
  ) {}

  @Public()
  @Get('serve')
  @ApiOperation({ summary: 'Servir la imagen de un item (URL firmada por pos_api).' })
  @ApiResponse({ status: 200, description: 'Bytes de la imagen' })
  @ApiResponse({ status: 403, description: 'Firma inválida o vencida' })
  @ApiResponse({ status: 404, description: 'Imagen no encontrada' })
  serve(
    @Query('o') objectName: string | undefined,
    @Query('e') expires: string | undefined,
    @Query('s') signature: string | undefined,
    @Res() res: Response,
  ): void {
    if (!objectName || !expires || !signature) {
      res.status(400).json({ success: false, error: 'Solicitud de imagen incompleta.' });
      return;
    }

    const verification = this.signer.verify(objectName, Number(expires), signature);
    if (!verification.ok) {
      // 403 tanto para firma mala como vencida: el front cae al placeholder y en
      // el siguiente refetch recibe una URL nueva. El motivo solo va al log.
      res.status(403).json({ success: false, error: 'Enlace de imagen inválido o vencido.' });
      return;
    }

    // Defensa en profundidad: solo se sirven objetos de la carpeta de imágenes.
    // (La firma ya lo garantiza, pero un objeto fuera del prefijo jamás se sirve.)
    if (!objectName.startsWith(`${this.storage.prefix}/`)) {
      res.status(400).json({ success: false, error: 'Ruta de imagen no permitida.' });
      return;
    }

    let stream: NodeJS.ReadableStream;
    try {
      stream = this.storage.createReadStream(objectName);
    } catch {
      // Sin bucket configurado (getBucket lanza 503). Para un <img>, un 404 basta.
      res.status(404).json({ success: false, error: 'Imagen no disponible.' });
      return;
    }

    // El objeto es inmutable: su nombre lleva un sufijo aleatorio y cambia con
    // cada imagen nueva. Cachear agresivo en el navegador es seguro.
    res.setHeader('Content-Type', contentTypeForObject(objectName));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

    stream.on('error', (err: NodeJS.ErrnoException) => {
      // Objeto ausente o lectura fallida. Si aún no se enviaron cabeceras, 404;
      // si el stream ya arrancó, solo se corta.
      if (!res.headersSent) {
        this.logger.warn(`No se pudo leer la imagen ${objectName}: ${err.message}`);
        res.status(404).json({ success: false, error: 'Imagen no encontrada.' });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  }
}
