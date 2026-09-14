import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

import {
  detectImageMime,
  maxSizeMessage,
  validateImageFile,
  type UploadedImageFile,
} from '../image-file';

/**
 * Validación del archivo que llega al endpoint de imagen.
 *
 * Lo que se fija aquí:
 *   - El formato se decide por los BYTES, nunca por el `Content-Type` (que lo
 *     escribe el cliente y se puede falsear).
 *   - Un archivo por encima del tope responde 413, no 400: el usuario tiene que
 *     poder distinguir "pesa mucho" de "no es una imagen".
 *   - Ausente/vacío es 400 con código propio.
 */

const MAX = 2 * 1024 * 1024;

/** Cabecera JPEG real seguida de relleno. */
function jpegBuffer(size = 64): Buffer {
  const buffer = Buffer.alloc(size, 0x20);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  return buffer;
}

function pngBuffer(size = 64): Buffer {
  const buffer = Buffer.alloc(size, 0x20);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  return buffer;
}

function webpBuffer(size = 64): Buffer {
  const buffer = Buffer.alloc(size, 0x20);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  return buffer;
}

function file(buffer: Buffer, mimetype = 'image/jpeg'): UploadedImageFile {
  return { buffer, mimetype, size: buffer.length, originalname: 'foto.jpg' };
}

describe('detectImageMime · formato por los bytes reales', () => {
  it('reconoce JPEG', () => {
    expect(detectImageMime(jpegBuffer())).toBe('image/jpeg');
  });

  it('reconoce PNG', () => {
    expect(detectImageMime(pngBuffer())).toBe('image/png');
  });

  it('reconoce WebP', () => {
    expect(detectImageMime(webpBuffer())).toBe('image/webp');
  });

  it('rechaza un buffer que no es imagen aunque el nombre diga .jpg', () => {
    expect(detectImageMime(Buffer.from('<html><body>hola</body></html>'))).toBeNull();
  });

  it('rechaza un GIF (formato no soportado)', () => {
    const gif = Buffer.alloc(32);
    gif.write('GIF89a', 0, 'ascii');
    expect(detectImageMime(gif)).toBeNull();
  });

  it('rechaza un buffer demasiado corto para tener cabecera', () => {
    expect(detectImageMime(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('un RIFF que NO es WebP (ej. WAV) se rechaza', () => {
    const wav = Buffer.alloc(32);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    expect(detectImageMime(wav)).toBeNull();
  });
});

describe('validateImageFile · casos válidos', () => {
  it('acepta un JPEG y devuelve su extensión', () => {
    const result = validateImageFile(file(jpegBuffer()), MAX);
    expect(result.mime).toBe('image/jpeg');
    expect(result.extension).toBe('jpg');
    expect(result.sizeBytes).toBe(64);
  });

  it('acepta PNG y WebP con su extensión correspondiente', () => {
    expect(validateImageFile(file(pngBuffer(), 'image/png'), MAX).extension).toBe('png');
    expect(validateImageFile(file(webpBuffer(), 'image/webp'), MAX).extension).toBe('webp');
  });

  it('el tipo REAL manda sobre el Content-Type declarado por el cliente', () => {
    // El cliente dice PNG pero manda un JPEG: se guarda como .jpg.
    const result = validateImageFile(file(jpegBuffer(), 'image/png'), MAX);
    expect(result.mime).toBe('image/jpeg');
    expect(result.extension).toBe('jpg');
  });

  it('acepta un archivo EXACTAMENTE en el límite', () => {
    expect(() => validateImageFile(file(jpegBuffer(MAX)), MAX)).not.toThrow();
  });
});

describe('validateImageFile · casos inválidos', () => {
  it('sin archivo → 400 MISSING_IMAGE', () => {
    expect(() => validateImageFile(undefined, MAX)).toThrow(BadRequestException);
  });

  it('archivo vacío → 400 MISSING_IMAGE', () => {
    expect(() => validateImageFile(file(Buffer.alloc(0)), MAX)).toThrow(BadRequestException);
  });

  it('un byte por encima del límite → 413', () => {
    expect(() => validateImageFile(file(jpegBuffer(MAX + 1)), MAX)).toThrow(
      PayloadTooLargeException,
    );
  });

  it('el mensaje del 413 dice cuántos MB se permiten', () => {
    try {
      validateImageFile(file(jpegBuffer(MAX + 1)), MAX);
      fail('debió lanzar');
    } catch (e) {
      expect((e as PayloadTooLargeException).getResponse()).toMatchObject({
        message: 'La imagen supera el límite de 2 MB.',
        payload: { code: 'IMAGE_TOO_LARGE' },
      });
    }
  });

  it('un PDF disfrazado de imagen → 400 INVALID_IMAGE_FORMAT', () => {
    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\nmás contenido');
    try {
      validateImageFile(file(pdf, 'image/jpeg'), MAX);
      fail('debió lanzar');
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({
        payload: { code: 'INVALID_IMAGE_FORMAT' },
      });
    }
  });

  it('el peso se evalúa ANTES que el formato (un archivo enorme no se inspecciona)', () => {
    const huge = Buffer.alloc(MAX + 1, 0x00); // ni siquiera es imagen
    expect(() => validateImageFile(file(huge), MAX)).toThrow(PayloadTooLargeException);
  });
});

describe('maxSizeMessage', () => {
  it('no rellena decimales cuando el límite es exacto', () => {
    expect(maxSizeMessage(2 * 1024 * 1024)).toBe('La imagen supera el límite de 2 MB.');
  });

  it('conserva los decimales cuando el límite no es entero', () => {
    expect(maxSizeMessage(1.5 * 1024 * 1024)).toBe('La imagen supera el límite de 1.5 MB.');
  });
});
