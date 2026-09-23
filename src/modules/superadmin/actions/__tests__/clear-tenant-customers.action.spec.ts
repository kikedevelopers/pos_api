import { NotFoundException } from '@nestjs/common';

import { ClearTenantCustomersAction } from '../clear-tenant-customers.action';

type CustomerRow = { id: string; protected: boolean; is_archived: boolean };

/**
 * Manager mock: responde a las tres consultas del action según el SQL que
 * recibe (clasificación, archivado y conteo final). El DELETE devuelve las
 * filas borradas (RETURNING id) para que el conteo salga del resultado real.
 */
function buildManager(rows: CustomerRow[]) {
  const calls: string[] = [];
  const deletable = rows.filter((r) => !r.protected).map((r) => r.id);

  const answer = (sql: string): unknown => {
    calls.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('FROM protection')) {
      return rows;
    }
    if (sql.startsWith('UPDATE customers')) {
      return [[], rows.filter((r) => r.protected && !r.is_archived).length];
    }
    if (sql.includes('DELETE FROM customers')) {
      return deletable.map((id) => ({ id }));
    }
    if (sql.includes('count(*) AS remaining')) {
      return [{ remaining: '0' }];
    }
    return [];
  };

  const query = jest.fn(
    (sql: string, _params?: unknown[]): Promise<unknown> => Promise.resolve(answer(sql)),
  );

  const manager = {
    query,
    getRepository: () => ({ findOne: (): Promise<unknown> => Promise.resolve({ id: '9' }) }),
  };
  return { manager, query, calls };
}

function buildAction(manager: unknown) {
  const dataSource = {
    transaction: (cb: (m: unknown) => Promise<unknown>) => cb(manager),
  };
  return new ClearTenantCustomersAction(dataSource as never);
}

describe('ClearTenantCustomersAction', () => {
  it('borra los clientes sin historial y archiva los protegidos', async () => {
    const { manager } = buildManager([
      { id: '1', protected: false, is_archived: false },
      { id: '2', protected: false, is_archived: false },
      { id: '3', protected: true, is_archived: false },
    ]);

    const result = await buildAction(manager).execute(9);

    expect(result).toEqual({ deleted: 2, archived: 1, remaining: 0 });
  });

  it('no vuelve a archivar los que ya estaban archivados', async () => {
    const { manager, query } = buildManager([
      { id: '1', protected: true, is_archived: true },
      { id: '2', protected: true, is_archived: false },
    ]);

    await buildAction(manager).execute(9);

    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE customers'));
    expect(update?.[1]).toEqual([['2']]);
  });

  it('borra también los archivados que no tienen historial (limpieza)', async () => {
    const { manager, query } = buildManager([
      { id: '1', protected: false, is_archived: true },
      { id: '2', protected: false, is_archived: false },
    ]);

    const result = await buildAction(manager).execute(9);

    expect(result.deleted).toBe(2);
    const del = query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM customers'));
    expect(del?.[1]).toEqual([['1', '2']]);
  });

  it('no ejecuta borrados si todo está protegido', async () => {
    const { manager, query } = buildManager([
      { id: '1', protected: true, is_archived: false },
      { id: '2', protected: true, is_archived: false },
    ]);

    const result = await buildAction(manager).execute(9);

    expect(result).toEqual({ deleted: 0, archived: 2, remaining: 0 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM customers'))).toBe(
      false,
    );
  });

  it('no ejecuta el UPDATE si no hay nada que archivar', async () => {
    const { manager, query } = buildManager([{ id: '1', protected: false, is_archived: false }]);

    await buildAction(manager).execute(9);

    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE customers'))).toBe(
      false,
    );
  });

  it('lista vacía: no toca nada', async () => {
    const { manager, query } = buildManager([]);

    const result = await buildAction(manager).execute(9);

    expect(result).toEqual({ deleted: 0, archived: 0, remaining: 0 });
    // Solo la clasificación y el conteo final.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('404 si la company no existe', async () => {
    const manager = {
      query: jest.fn(),
      getRepository: () => ({ findOne: (): Promise<unknown> => Promise.resolve(null) }),
    };
    await expect(buildAction(manager).execute(404)).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('archiva marcando is_archived (sin tocar ventas ni anticipos)', async () => {
    const { manager, calls } = buildManager([{ id: '1', protected: true, is_archived: false }]);

    await buildAction(manager).execute(9);

    const update = calls.find((sql) => sql.startsWith('UPDATE customers'));
    expect(update).toContain('is_archived = true');
  });
});
