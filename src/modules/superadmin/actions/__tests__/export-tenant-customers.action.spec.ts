import { NotFoundException } from '@nestjs/common';

import { ExportTenantCustomersAction } from '../export-tenant-customers.action';

/**
 * DataSource mock: `getRepository().findOne` decide si la company existe (y da
 * su nombre) y `query` devuelve las filas de clientes activos.
 */
function buildDataSource(opts: { company?: unknown; rows?: Record<string, unknown>[] }) {
  const query = jest.fn((): Promise<unknown> => Promise.resolve(opts.rows ?? []));
  const dataSource = {
    getRepository: () => ({
      findOne: (): Promise<unknown> =>
        Promise.resolve('company' in opts ? opts.company : { id: '9', name: 'Autoservicio' }),
    }),
    query,
  };
  return { dataSource, query };
}

describe('ExportTenantCustomersAction', () => {
  it('devuelve companyId, companyName y las filas tal cual (incluye category por nombre)', async () => {
    const { dataSource } = buildDataSource({
      company: { id: '9', name: 'Autoservicio Elihan' },
      rows: [
        {
          person_type: 'INDIVIDUAL',
          name: 'Ana',
          doc_number: '123',
          phone: '300',
          email: 'ana@x.com',
          address: 'Calle 1',
          category: 'VIP',
        },
        {
          person_type: 'COMPANY',
          name: 'Beta SAS',
          doc_number: null,
          phone: null,
          email: null,
          address: null,
          category: null,
        },
      ],
    });

    const result = await new ExportTenantCustomersAction(dataSource as never).execute(9);

    expect(result.companyId).toBe(9);
    expect(result.companyName).toBe('Autoservicio Elihan');
    expect(result.customers).toEqual([
      {
        person_type: 'INDIVIDUAL',
        name: 'Ana',
        doc_number: '123',
        phone: '300',
        email: 'ana@x.com',
        address: 'Calle 1',
        category: 'VIP',
      },
      {
        person_type: 'COMPANY',
        name: 'Beta SAS',
        doc_number: null,
        phone: null,
        email: null,
        address: null,
        category: null,
      },
    ]);
  });

  it('sin clientes devuelve la lista vacía', async () => {
    const { dataSource } = buildDataSource({ rows: [] });

    const result = await new ExportTenantCustomersAction(dataSource as never).execute(9);

    expect(result.customers).toEqual([]);
  });

  it('404 si la company no existe (sin consultar clientes)', async () => {
    const { dataSource, query } = buildDataSource({ company: null });

    await expect(
      new ExportTenantCustomersAction(dataSource as never).execute(404),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(query).not.toHaveBeenCalled();
  });
});
