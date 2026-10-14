import type { DataSource } from 'typeorm';

import { CheckCatalogSlugAction } from '../actions/check-catalog-slug.action';
import type { Company } from '../entities/company.entity';

describe('CheckCatalogSlugAction', () => {
  let action: CheckCatalogSlugAction;
  let takenBy: string | null; // slug tomado por otra company

  const build = (): void => {
    const manager = {
      findOne: jest.fn((_e: unknown, opts: { where: { catalog_slug: string } }) =>
        Promise.resolve(takenBy === opts.where.catalog_slug ? ({ id: '999' } as Company) : null),
      ),
    };
    const dataSource = { manager } as unknown as DataSource;
    action = new CheckCatalogSlugAction(dataSource);
  };

  beforeEach(() => {
    takenBy = null;
    build();
  });

  it('normaliza y reporta disponible', async () => {
    const res = await action.execute(42, 'Esencia y Grano');
    expect(res).toEqual({ slug: 'esenciaygrano', valid: true, available: true, reason: undefined });
  });

  it('reporta no disponible si otra company lo tiene', async () => {
    takenBy = 'esenciaygrano';
    build();
    const res = await action.execute(42, 'esenciaygrano');
    expect(res.valid).toBe(true);
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/en uso/i);
  });

  it('marca inválido un slug muy corto', async () => {
    const res = await action.execute(42, 'ab');
    expect(res.valid).toBe(false);
    expect(res.available).toBe(false);
  });

  it('marca inválido un slug sin caracteres válidos', async () => {
    const res = await action.execute(42, '---');
    expect(res).toMatchObject({ slug: '', valid: false, available: false });
  });
});
