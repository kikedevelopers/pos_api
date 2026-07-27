import { NotFoundException } from '@nestjs/common';

import { ClearTenantInventoryAction } from '../clear-tenant-inventory.action';

type ProductRow = { id: string; protected: boolean; is_archived: boolean };

/**
 * Manager mock: responde a las cuatro consultas del action según el SQL que
 * recibe (clasificación, archivado, borrado por niveles y conteo final).
 * `deletedByPass` simula la jerarquía: cada vuelta borra el lote indicado.
 */
function buildManager(rows: ProductRow[], deletedByPass?: string[][]) {
  const calls: string[] = [];
  let pass = 0;
  const deletable = rows.filter((r) => !r.protected).map((r) => r.id);

  const answer = (sql: string): unknown => {
    calls.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('JOIN protection')) {
      return rows;
    }
    if (sql.startsWith('UPDATE products')) {
      return [[], rows.filter((r) => r.protected).length];
    }
    if (sql.includes('DELETE FROM products')) {
      const batch = deletedByPass ? (deletedByPass[pass] ?? []) : pass === 0 ? deletable : [];
      pass += 1;
      return batch.map((id) => ({ id }));
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
  return new ClearTenantInventoryAction(dataSource as never);
}

describe('ClearTenantInventoryAction', () => {
  it('borra los productos sin historial y archiva los protegidos', async () => {
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

    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE products'));
    expect(update?.[1]).toEqual([['2']]);
  });

  it('borra también los archivados que no tienen historial (limpieza)', async () => {
    const { manager, query } = buildManager([
      { id: '1', protected: false, is_archived: true },
      { id: '2', protected: false, is_archived: false },
    ]);

    const result = await buildAction(manager).execute(9);

    expect(result.deleted).toBe(2);
    const del = query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM products'));
    expect(del?.[1]).toEqual([['1', '2']]);
  });

  it('borra por niveles: presentaciones primero, luego su base', async () => {
    // '10' es base de '11'; la primera vuelta solo puede borrar la hoja.
    const { manager, query } = buildManager(
      [
        { id: '10', protected: false, is_archived: false },
        { id: '11', protected: false, is_archived: false },
      ],
      [['11'], ['10'], []],
    );

    const result = await buildAction(manager).execute(9);

    expect(result.deleted).toBe(2);
    const deletes = query.mock.calls.filter(([sql]) =>
      String(sql).includes('DELETE FROM products'),
    );
    expect(deletes).toHaveLength(2);
  });

  it('no ejecuta borrados si todo está protegido', async () => {
    const { manager, query } = buildManager([
      { id: '1', protected: true, is_archived: false },
      { id: '2', protected: true, is_archived: false },
    ]);

    const result = await buildAction(manager).execute(9);

    expect(result).toEqual({ deleted: 0, archived: 2, remaining: 0 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM products'))).toBe(
      false,
    );
  });

  it('no ejecuta el UPDATE si no hay nada que archivar', async () => {
    const { manager, query } = buildManager([{ id: '1', protected: false, is_archived: false }]);

    await buildAction(manager).execute(9);

    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE products'))).toBe(false);
  });

  it('inventario vacío: no toca nada', async () => {
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

  it('corta el bucle si una jerarquía imposible impide borrar (no cuelga)', async () => {
    const { manager, query } = buildManager(
      [
        { id: '1', protected: false, is_archived: false },
        { id: '2', protected: false, is_archived: false },
      ],
      [[]], // ninguna vuelta borra nada
    );

    const result = await buildAction(manager).execute(9);

    expect(result.deleted).toBe(0);
    const deletes = query.mock.calls.filter(([sql]) =>
      String(sql).includes('DELETE FROM products'),
    );
    expect(deletes).toHaveLength(1); // se detiene en cuanto una vuelta no avanza
  });

  it('archiva sacando el producto del POS', async () => {
    const { manager, calls } = buildManager([{ id: '1', protected: true, is_archived: false }]);

    await buildAction(manager).execute(9);

    const update = calls.find((sql) => sql.startsWith('UPDATE products'));
    expect(update).toContain('is_archived = true');
    expect(update).toContain('show_in_pos = false');
  });

  it('borra el historial interno de precio y costo antes que el producto', async () => {
    const { manager, calls } = buildManager([{ id: '1', protected: false, is_archived: false }]);

    await buildAction(manager).execute(9);

    const costIdx = calls.findIndex((s) => s.includes('DELETE FROM product_cost_history'));
    const priceIdx = calls.findIndex((s) => s.includes('DELETE FROM product_price_history'));
    const prodIdx = calls.findIndex((s) => s.includes('DELETE FROM products'));
    expect(costIdx).toBeGreaterThanOrEqual(0);
    expect(priceIdx).toBeGreaterThanOrEqual(0);
    expect(costIdx).toBeLessThan(prodIdx);
    expect(priceIdx).toBeLessThan(prodIdx);
  });
});
