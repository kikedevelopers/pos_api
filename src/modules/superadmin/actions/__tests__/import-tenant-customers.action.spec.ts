import { NotFoundException } from '@nestjs/common';

import { PersonType } from '@/modules/customers/entities/customer.entity';

import {
  ImportTenantCustomersAction,
  type ImportCustomerRow,
} from '../import-tenant-customers.action';

/**
 * Manager mock de la transacción:
 *   - getRepository().findOne → company (o null).
 *   - query → filas de llaves existentes en el destino (loadExistingKeys).
 *   - find → categorías ACTIVAS existentes.
 *   - create(Entity, obj) → devuelve el objeto (lo inspeccionamos).
 *   - save(Entity, array) → clientes; save(entity) → categoría (le asigna id).
 */
function buildManager(opts: {
  company?: unknown;
  existing?: { doc_key: string | null; name_key: string }[];
  categories?: { id: string; name: string; is_archived?: boolean }[];
}) {
  const savedCustomers: Record<string, unknown>[] = [];
  const createdCategories: Record<string, unknown>[] = [];
  let catSeq = 1000;

  const manager = {
    getRepository: () => ({
      findOne: (): Promise<unknown> =>
        Promise.resolve('company' in opts ? opts.company : { id: '7', name: 'Destino' }),
    }),
    query: jest.fn((): Promise<unknown> => Promise.resolve(opts.existing ?? [])),
    find: jest.fn((): Promise<unknown> => Promise.resolve(opts.categories ?? [])),
    create: jest.fn((_entity: unknown, obj: Record<string, unknown>) => ({ ...obj })),
    save: jest.fn((a: unknown, b?: unknown): Promise<unknown> => {
      if (typeof a === 'function') {
        // save(Entity, array) — los clientes se guardan en lotes.
        if (Array.isArray(b)) {
          savedCustomers.push(...(b as Record<string, unknown>[]));
          return Promise.resolve(b);
        }
        return Promise.resolve(b);
      }
      // save(entity) — categoría find-or-create: le asignamos un id nuevo.
      const cat = { ...(a as Record<string, unknown>), id: String(catSeq++) };
      createdCategories.push(cat);
      return Promise.resolve(cat);
    }),
  };

  const dataSource = {
    transaction: (cb: (m: typeof manager) => unknown) => cb(manager),
  };

  return { dataSource, manager, savedCustomers, createdCategories };
}

const run = (
  ds: unknown,
  companyId: number,
  rows: ImportCustomerRow[],
) => new ImportTenantCustomersAction(ds as never).execute(companyId, rows);

describe('ImportTenantCustomersAction', () => {
  it('inserta todas las filas cuando el destino está vacío', async () => {
    const { dataSource, savedCustomers } = buildManager({ existing: [], categories: [] });

    const result = await run(dataSource, 7, [
      { name: 'Ana', doc_number: '1', phone: '300' },
      { name: 'Beto', doc_number: '2' },
    ]);

    expect(result).toEqual({
      inserted: 2,
      skippedExisting: 0,
      skippedInvalid: 0,
      categoriesCreated: 0,
    });
    expect(savedCustomers).toHaveLength(2);
    expect(savedCustomers[0]).toMatchObject({
      company_id: '7',
      name: 'Ana',
      doc_number: '1',
      phone: '300',
      balance: 0,
      advance_balance: 0,
      points: 0,
      is_archived: false,
      created_by_id: null,
    });
  });

  it('omite por doc_number ya existente en el destino', async () => {
    const { dataSource } = buildManager({
      existing: [{ doc_key: '1', name_key: 'otro' }],
    });

    const result = await run(dataSource, 7, [
      { name: 'Ana', doc_number: '1' }, // existe por doc → omitida
      { name: 'Beto', doc_number: '2' }, // nueva
    ]);

    expect(result.inserted).toBe(1);
    expect(result.skippedExisting).toBe(1);
  });

  it('omite por nombre cuando la fila no trae documento', async () => {
    const { dataSource } = buildManager({
      existing: [{ doc_key: null, name_key: 'ana' }],
    });

    const result = await run(dataSource, 7, [
      { name: 'Ana' }, // mismo nombre, sin doc → omitida
      { name: 'ANA ' }, // normaliza igual → también omitida (ya en existing)
      { name: 'Clara' }, // nueva
    ]);

    expect(result.inserted).toBe(1);
    expect(result.skippedExisting).toBe(2);
  });

  it('deduplica dentro del mismo archivo (doc repetido)', async () => {
    const { dataSource } = buildManager({ existing: [] });

    const result = await run(dataSource, 7, [
      { name: 'Ana', doc_number: '5' },
      { name: 'Ana otra vez', doc_number: '5' }, // mismo doc dentro del CSV
    ]);

    expect(result.inserted).toBe(1);
    expect(result.skippedExisting).toBe(1);
  });

  it('cuenta como inválidas las filas sin nombre', async () => {
    const { dataSource } = buildManager({ existing: [] });

    const result = await run(dataSource, 7, [
      { name: '   ', doc_number: '1' },
      { name: '', doc_number: '2' },
      { name: 'Ok', doc_number: '3' },
    ]);

    expect(result.inserted).toBe(1);
    expect(result.skippedInvalid).toBe(2);
  });

  it('reusa categoría existente por nombre y crea las nuevas (find-or-create)', async () => {
    const { dataSource, savedCustomers, createdCategories } = buildManager({
      existing: [],
      categories: [{ id: '50', name: 'VIP', is_archived: false }],
    });

    const result = await run(dataSource, 7, [
      { name: 'Ana', doc_number: '1', category: 'VIP' }, // existente → id 50
      { name: 'Beto', doc_number: '2', category: 'Mayorista' }, // nueva
      { name: 'Clara', doc_number: '3', category: 'mayorista' }, // misma nueva (cache)
    ]);

    expect(result.inserted).toBe(3);
    expect(result.categoriesCreated).toBe(1);
    expect(createdCategories).toHaveLength(1);
    expect(savedCustomers[0].category_id).toBe('50');
    expect(savedCustomers[1].category_id).toBe(savedCustomers[2].category_id);
  });

  it('normaliza person_type (COMPANY vs resto → INDIVIDUAL)', async () => {
    const { dataSource, savedCustomers } = buildManager({ existing: [] });

    await run(dataSource, 7, [
      { name: 'Empresa', doc_number: '1', person_type: 'company' },
      { name: 'Persona', doc_number: '2', person_type: 'loquesea' },
      { name: 'SinTipo', doc_number: '3' },
    ]);

    expect(savedCustomers[0].person_type).toBe(PersonType.COMPANY);
    expect(savedCustomers[1].person_type).toBe(PersonType.INDIVIDUAL);
    expect(savedCustomers[2].person_type).toBe(PersonType.INDIVIDUAL);
  });

  it('normaliza vacíos a null en los campos opcionales', async () => {
    const { dataSource, savedCustomers } = buildManager({ existing: [] });

    await run(dataSource, 7, [
      { name: '  Ana  ', doc_number: '  ', phone: '', email: '  ', address: '', category: '' },
    ]);

    expect(savedCustomers[0]).toMatchObject({
      name: 'Ana',
      doc_number: null,
      phone: null,
      email: null,
      address: null,
      category_id: null,
    });
  });

  it('404 si la company destino no existe', async () => {
    const { dataSource } = buildManager({ company: null });

    await expect(run(dataSource, 404, [{ name: 'Ana' }])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
