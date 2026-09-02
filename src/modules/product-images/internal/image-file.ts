import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/**
 * Formatos aceptados para la imagen de un item del inventario.
 *
 * La extensión sale del TIPO REAL detectado, nunca del nombre que mandó el
 * cliente: un `.jpg` puede traer cualquier cosa adentro.
 */
export const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export type AllowedImageMime = keyof typeof ALLOWED_IMAGE_TYPES;

/** Dimensión recomendada (cuadrada) que se le comunica al usuario. */
export const RECOMMENDED_IMAGE_SIZE_PX = 800;

/** Archivo tal como lo entrega multer, con lo mínimo que necesitamos. */
export interface UploadedImageFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

/** Resultado de validar: el tipo REAL y la extensión que tendrá el objeto. */
export interface ValidatedImage {
  mime: AllowedImageMime;
  extension: string;
  buffer: Buffer;
  sizeBytes: number;
}

/**
 * Detecta el formato leyendo los MAGIC BYTES del archivo.
 *
 * El `Content-Type` del multipart lo escribe el cliente y se puede falsear; la
 * cabecera del binario no. Sin esto, cualquiera podría dejar un HTML o un
 * ejecutable en el bucket con el disfraz de `image/png`.
 */
export function detectImageMime(buffer: Buffer): AllowedImageMime | null {
  if (buffer.length < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG_SIGNATURE.every((byte, i) => buffer[i] === byte)) {
    return 'image/png';
  }

  // WebP: "RIFF" …4 bytes de tamaño… "WEBP"
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

/** Mensaje único del límite de peso, para que front y back digan lo mismo. */
export function maxSizeMessage(maxSizeBytes: number): string {
  const mb = maxSizeBytes / (1024 * 1024);
  // Sin decimales de relleno: "2 MB", pero "1.5 MB" cuando los tiene.
  const pretty = Number(mb.toFixed(2));
  return `La imagen supera el límite de ${pretty} MB.`;
}

/**
 * Valida el archivo subido: que venga, que pese menos del tope y que sea de
 * verdad una imagen de un formato soportado.
 *
 * Lanza 400 (o 413 si es cuestión de peso) con un mensaje que se le puede
 * mostrar tal cual al usuario.
 */
export function validateImageFile(
  file: UploadedImageFile | undefined,
  maxSizeBytes: number,
): ValidatedImage {
  if (!file?.buffer || file.buffer.length === 0) {
    throw new BadRequestException({
      message: 'Debes seleccionar una imagen.',
      payload: { code: 'MISSING_IMAGE' },
    });
  }

  const sizeBytes = file.buffer.length;
  if (sizeBytes > maxSizeBytes) {
    throw new PayloadTooLargeException({
      message: maxSizeMessage(maxSizeBytes),
      payload: { code: 'IMAGE_TOO_LARGE' },
    });
  }

  const mime = detectImageMime(file.buffer);
  if (!mime) {
    throw new BadRequestException({
      message: 'Formato no soportado. Usa una imagen JPG, PNG o WebP.',
      payload: { code: 'INVALID_IMAGE_FORMAT' },
    });
  }

  return { mime, extension: ALLOWED_IMAGE_TYPES[mime], buffer: file.buffer, sizeBytes };
}
