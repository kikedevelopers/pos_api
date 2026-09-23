import { NotFoundException } from '@nestjs/common';

import { GetTenantCustomersAction } from '../get-tenant-customers.action';

/**
 * DataSource mock: `getRepository().findOne` decide si la company existe y
 * `query` devuelve la fila-resumen (los conteos vienen de pg como string).
 */
function buildDataSource(opts: {
  company?: unknown;
  row?: Record<string, string>;
}) {
  const query = jest.fn((): Promise<unknown> => Promise.resolve(opts.row ? [opts.row] : [{}]));
  const dataSource = {
    getRepository: () => ({
      findOne: (): Promise<unknown> =>
        Promise.resolve('company' in opts ? opts.company : { id: '9' }),
    }),
    query,
  };
  return { dataSource, query };
}

describe('GetTenantCustomersAction', () => {
  it('mapea la fila (strings de pg) a números', async () => {
    const { dataSource } = buildDataSource({
      row: { active: '40', archived: '3', deletable: '12', protectable: '31' },
    });

    const result = await new GetTenantCustomersAction(dataSource as never).execute(9);

    expect(result).toEqual({ active: 40, archived: 3, deletable: 12, protectable: 31 });
  });

  it('sin clientes devuelve todo en cero (fila con nulos)', async () => {
    const { dataSource } = buildDataSource({ row: {} });

    const result = await new GetTenantCustomersAction(dataSource as never).execute(9);

    expect(result).toEqual({ active: 0, archived: 0, deletable: 0, protectable: 0 });
  });

  it('404 si la company no existe (sin consultar el resumen)', async () => {
    const { dataSource, query } = buildDataSource({ company: null });

    await expect(new GetTenantCustomersAction(dataSource as never).execute(404)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
