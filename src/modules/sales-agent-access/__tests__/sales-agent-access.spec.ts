import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { INSERT_USAGE_EVENT_SQL } from '@/modules/ai/internal/ai-credits-sql';

import { SALES_AGENT_NOT_ENABLED, SalesAgentAccessService } from '../sales-agent-access.service';
import { SalesAgentEnabledGuard } from '../sales-agent-enabled.guard';

const makeService = (rows: unknown[] = []) => {
  const query = jest.fn().mockResolvedValue(rows);
  const service = new SalesAgentAccessService({ query } as unknown as DataSource);
  return { service, query };
};

const usage = {
  prompt_tokens: 90,
  output_tokens: 10,
  thoughts_tokens: 5,
  cached_tokens: 0,
  total_tokens: 105,
};

describe('SalesAgentAccessService.isEnabled', () => {
  it('true solo si la company tiene el flag encendido', async () => {
    await expect(makeService([{ sales_agent_enabled: true }]).service.isEnabled(7)).resolves.toBe(
      true,
    );
    await expect(makeService([{ sales_agent_enabled: false }]).service.isEnabled(7)).resolves.toBe(
      false,
    );
  });

  it('company inexistente → false', async () => {
    await expect(makeService([]).service.isEnabled(7)).resolves.toBe(false);
  });

  it('id inválido → false sin consultar', async () => {
    const { service, query } = makeService([{ sales_agent_enabled: true }]);
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(service.isEnabled(id)).resolves.toBe(false);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('consulta la company indicada (cada sucursal tiene su interruptor)', async () => {
    const { service, query } = makeService([{ sales_agent_enabled: true }]);
    await service.isEnabled(42);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM companies WHERE id = $1'), [
      '42',
    ]);
  });
});

describe('SalesAgentAccessService.assertEnabled', () => {
  it('habilitado: no lanza', async () => {
    await expect(
      makeService([{ sales_agent_enabled: true }]).service.assertEnabled(7),
    ).resolves.toBeUndefined();
  });

  it('inhabilitado: 403 con código SALES_AGENT_NOT_ENABLED', async () => {
    const error = await makeService([{ sales_agent_enabled: false }])
      .service.assertEnabled(7)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      payload: { code: SALES_AGENT_NOT_ENABLED },
    });
  });
});

describe('SalesAgentAccessService.enabledCompanyIds', () => {
  it('devuelve los ids numéricos de los negocios habilitados', async () => {
    const { service } = makeService([{ id: '7' }, { id: '12' }]);
    await expect(service.enabledCompanyIds()).resolves.toEqual([7, 12]);
  });
});

describe('SalesAgentAccessService.recordUsage', () => {
  it('inserta el consumo con su tipo (sin usuario: lo genera un cliente del negocio)', async () => {
    const { service, query } = makeService();
    await service.recordUsage({
      companyId: 7,
      kind: 'sales_agent',
      model: 'gemini-flash-lite-latest',
      usage,
      rounds: 2,
    });
    expect(query).toHaveBeenCalledWith(INSERT_USAGE_EVENT_SQL, [
      '7',
      null,
      'sales_agent',
      'gemini-flash-lite-latest',
      90,
      10,
      5,
      0,
      105,
      2,
    ]);
  });

  it('sin consumo (o sin datos de uso) no inserta nada', async () => {
    const { service, query } = makeService();
    await service.recordUsage({
      companyId: 7,
      kind: 'sales_agent',
      model: 'm',
      usage: undefined,
      rounds: 1,
    });
    await service.recordUsage({
      companyId: 7,
      kind: 'sales_agent',
      model: 'm',
      usage: { ...usage, total_tokens: 0 },
      rounds: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('si la BD falla no lanza (el cliente igual recibe su respuesta)', async () => {
    const { service, query } = makeService();
    query.mockRejectedValue(new Error('db down'));
    await expect(
      service.recordUsage({ companyId: 7, kind: 'catalog_suggest', model: 'm', usage, rounds: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe('SalesAgentEnabledGuard', () => {
  const contextFor = (user: unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  it('deja pasar si el negocio del usuario tiene el agente', async () => {
    const access = { assertEnabled: jest.fn().mockResolvedValue(undefined) };
    const guard = new SalesAgentEnabledGuard(access as unknown as SalesAgentAccessService);
    await expect(guard.canActivate(contextFor({ company_id: 7 }))).resolves.toBe(true);
    expect(access.assertEnabled).toHaveBeenCalledWith(7);
  });

  it('propaga el 403 si no lo tiene', async () => {
    const access = { assertEnabled: jest.fn().mockRejectedValue(new ForbiddenException('no')) };
    const guard = new SalesAgentEnabledGuard(access as unknown as SalesAgentAccessService);
    await expect(guard.canActivate(contextFor({ company_id: 7 }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('sin usuario o sin company (p. ej. superadmin) → 403', async () => {
    const access = { assertEnabled: jest.fn() };
    const guard = new SalesAgentEnabledGuard(access as unknown as SalesAgentAccessService);
    await expect(guard.canActivate(contextFor(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(guard.canActivate(contextFor({ company_id: null }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(access.assertEnabled).not.toHaveBeenCalled();
  });
});
