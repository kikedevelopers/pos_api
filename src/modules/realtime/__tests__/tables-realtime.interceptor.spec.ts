import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { TablesRealtimeInterceptor } from '../tables-realtime.interceptor';

function context(method: string, user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
  } as unknown as ExecutionContext;
}
const next: CallHandler = { handle: () => of('ok') };

describe('TablesRealtimeInterceptor', () => {
  const build = () => {
    const emitTablesChanged = jest.fn();
    const interceptor = new TablesRealtimeInterceptor({ emitTablesChanged } as never);
    return { interceptor, emitTablesChanged };
  };

  it('emite tras una mutación (POST) con company válida', async () => {
    const { interceptor, emitTablesChanged } = build();
    await lastValueFrom(interceptor.intercept(context('POST', { company_id: 42 }), next));
    expect(emitTablesChanged).toHaveBeenCalledWith(42);
  });

  it('NO emite en GET (no muta estado)', async () => {
    const { interceptor, emitTablesChanged } = build();
    await lastValueFrom(interceptor.intercept(context('GET', { company_id: 42 }), next));
    expect(emitTablesChanged).not.toHaveBeenCalled();
  });

  it('NO emite sin company (login/superadmin)', async () => {
    const { interceptor, emitTablesChanged } = build();
    await lastValueFrom(interceptor.intercept(context('POST', { company_id: null }), next));
    expect(emitTablesChanged).not.toHaveBeenCalled();
  });

  it('un fallo de socket no rompe la respuesta (best-effort)', async () => {
    const emitTablesChanged = jest.fn(() => {
      throw new Error('socket caído');
    });
    const interceptor = new TablesRealtimeInterceptor({ emitTablesChanged } as never);
    await expect(
      lastValueFrom(interceptor.intercept(context('POST', { company_id: 42 }), next)),
    ).resolves.toBe('ok');
  });
});
