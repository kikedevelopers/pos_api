import { StreamableFile, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';

import { ResponseWrapperInterceptor } from '../response-wrapper.interceptor';

describe('ResponseWrapperInterceptor', () => {
  const run = (value: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      const interceptor = new ResponseWrapperInterceptor();
      interceptor
        .intercept({} as ExecutionContext, { handle: () => of(value) } as CallHandler)
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
});
