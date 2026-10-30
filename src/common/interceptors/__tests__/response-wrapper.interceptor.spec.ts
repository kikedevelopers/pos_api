import { StreamableFile, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { of } from 'rxjs';

import { ResponseWrapperInterceptor } from '../response-wrapper.interceptor';

describe('ResponseWrapperInterceptor', () => {
  const run = (value: unknown, raw = false): Promise<unknown> =>
    new Promise((resolve) => {
      const reflector = { getAllAndOverride: () => raw } as unknown as Reflector;
      const interceptor = new ResponseWrapperInterceptor(reflector);
      const context = {
        getHandler: () => undefined,
        getClass: () => undefined,
      } as unknown as ExecutionContext;
      interceptor
        .intercept(context, { handle: () => of(value) } as CallHandler)
        .subscribe(resolve);
    });

  it('envuelve objetos en {success, payload}', async () => {
    expect(await run({ a: 1 })).toEqual({ success: true, payload: { a: 1 } });
  });

  it('undefined → payload null', async () => {
    expect(await run(undefined)).toEqual({ success: true, payload: null });
  });

  it('NO envuelve un StreamableFile (descarga binaria pasa tal cual)', async () => {
    const file = new StreamableFile(Buffer.from('%PDF-1.4'));
    expect(await run(file)).toBe(file);
  });

  it('con @RawResponse devuelve el valor CRUDO (ej. reto del webhook)', async () => {
    expect(await run('RETO_OK', true)).toBe('RETO_OK');
    expect(await run({ received: true }, true)).toEqual({ received: true });
  });
});
