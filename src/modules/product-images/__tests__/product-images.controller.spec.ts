import { EventEmitter } from 'events';
import type { Response } from 'express';

import { ProductImagesController } from '../product-images.controller';
import type { ImageProxySigner } from '../image-proxy-signer.service';
import type { ProductImageStorageService } from '../product-image-storage.service';

/** Stream falso: EventEmitter con `pipe` observable. */
class FakeStream extends EventEmitter {
  piped: unknown = null;
  pipe(dest: unknown) {
    this.piped = dest;
    return dest;
  }
}

/** Response de Express mínima para observar status/headers/stream. */
function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    getHeader(name: string) {
      return headers[name];
    },
    destroy: jest.fn(),
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    getHeader(n: string): string | undefined;
  };
}

const OBJECT = 'inventory_items/42/10472-abc.jpg';

function buildController(options: {
  verifyOk?: boolean;
  reason?: string;
  stream?: FakeStream;
  streamThrows?: boolean;
}) {
  const stream = options.stream ?? new FakeStream();
  const storage = {
    prefix: 'inventory_items',
    createReadStream: jest.fn(() => {
      if (options.streamThrows) throw new Error('sin bucket');
      return stream;
    }),
  } as unknown as ProductImageStorageService;

  const signer = {
    verify: jest.fn(() => ({ ok: options.verifyOk ?? true, reason: options.reason })),
  } as unknown as ImageProxySigner;

  return { controller: new ProductImagesController(storage, signer), storage, signer, stream };
}

describe('ProductImagesController · serve', () => {
  it('400 si faltan parámetros', () => {
    const { controller } = buildController({});
    const res = fakeResponse();
    controller.serve(undefined, undefined, undefined, res);
    expect(res.statusCode).toBe(400);
  });

  it('403 si la firma es inválida o vencida', () => {
    const { controller, storage } = buildController({ verifyOk: false, reason: 'expired' });
    const res = fakeResponse();
    controller.serve(OBJECT, '123', 'sig', res);
    expect(res.statusCode).toBe(403);
    // No intenta abrir el objeto si la firma no pasa.
    expect((storage.createReadStream as jest.Mock).mock.calls.length).toBe(0);
  });

  it('400 si el objeto no está bajo la carpeta de imágenes', () => {
    const { controller } = buildController({ verifyOk: true });
    const res = fakeResponse();
    controller.serve('backups/x.dump', '123', 'sig', res);
    expect(res.statusCode).toBe(400);
  });

  it('firma válida: setea Content-Type + cache y hace pipe del stream', () => {
    const { controller, stream } = buildController({ verifyOk: true });
    const res = fakeResponse();
    controller.serve(OBJECT, '123', 'sig', res);

    expect(res.getHeader('Content-Type')).toBe('image/jpeg');
    expect(res.getHeader('Cache-Control')).toContain('immutable');
    expect(stream.piped).toBe(res);
  });

  it('404 si abrir el objeto lanza (bucket no configurado)', () => {
    const { controller } = buildController({ verifyOk: true, streamThrows: true });
    const res = fakeResponse();
    controller.serve(OBJECT, '123', 'sig', res);
    expect(res.statusCode).toBe(404);
  });

  it('404 si el stream falla antes de enviar cabeceras (objeto ausente)', () => {
    const { controller, stream } = buildController({ verifyOk: true });
    const res = fakeResponse();
    controller.serve(OBJECT, '123', 'sig', res);
    // El objeto no existe: el stream emite error antes de cualquier byte.
    stream.emit('error', Object.assign(new Error('No such object'), { code: 404 }));
    expect(res.statusCode).toBe(404);
  });

  it('si el stream falla con cabeceras ya enviadas, corta la respuesta', () => {
    const { controller, stream } = buildController({ verifyOk: true });
    const res = fakeResponse();
    (res as unknown as { headersSent: boolean }).headersSent = true;
    controller.serve(OBJECT, '123', 'sig', res);
    stream.emit('error', new Error('cortado a mitad'));
    expect((res.destroy as jest.Mock).mock.calls.length).toBe(1);
  });
});
