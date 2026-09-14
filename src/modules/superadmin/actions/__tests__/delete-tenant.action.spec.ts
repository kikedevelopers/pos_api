import { NotFoundException } from '@nestjs/common';

import { DeleteTenantAction } from '../delete-tenant.action';

// ---------------------------------------------------------------------------
// Borrado de un tenant, con foco en las SUCURSALES.
//
// La cascada de la BD no alcanza a las sucursales: son companies propias, y lo
// único que las ata al principal es `company_members`, que cuelga del owner. Al
// borrar el principal el owner se va y las membresías caen, pero las companies
// de las sucursales sobrevivirían sin dueño ni forma de alcanzarlas — basura
// invisible con los datos del cliente dentro.
// ---------------------------------------------------------------------------

interface Options {
  company: Record<string, unknown> | null;
  /** Sucursales que devuelve la consulta por owner. */
  branchIds?: string[];
}

function build(opts: Options) {
  const del = jest.fn().mockResolvedValue({ affected: 1 });
  const query = jest.fn().mockResolvedValue((opts.branchIds ?? []).map((id) => ({ id })));
  const manager = {
    getRepository: () => ({
      findOne: jest.fn().mockResolvedValue(opts.company),
      delete: del,
    }),
    query,
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: unknown) => Promise<void>) => cb(manager)),
  };
  // Doble del servicio de imágenes: registra a qué companies se les pidió
  // limpiar el bucket (la cascada de la BD no llega hasta allí).
  const removeAllForCompany = jest.fn((_companyId: number) => Promise.resolve());
  return {
    action: new DeleteTenantAction(dataSource as never, { removeAllForCompany } as never),
    del,
    query,
    dataSource,
    removeAllForCompany,
  };
}

const PRINCIPAL = { id: '8', name: 'Esencia & Grano', is_branch: false };
const SUCURSAL = { id: '12', name: 'Esencia & Grano Sur', is_branch: true };

describe('DeleteTenantAction', () => {
  it('404 si la company no existe (no abre el camino destructivo)', async () => {
    const { action, del } = build({ company: null });

    await expect(action.execute(999)).rejects.toBeInstanceOf(NotFoundException);
    expect(del).not.toHaveBeenCalled();
  });

  it('borra el negocio principal sin sucursales', async () => {
    const { action, del } = build({ company: PRINCIPAL, branchIds: [] });

    await action.execute(8);

    expect(del).toHaveBeenCalledWith(['8']);
  });

  it('borrar el principal ARRASTRA sus sucursales', async () => {
    const { action, del } = build({ company: PRINCIPAL, branchIds: ['12', '30'] });

    await action.execute(8);

    expect(del).toHaveBeenCalledWith(['8', '12', '30']);
  });

  it('limpia del bucket las imágenes del tenant borrado', async () => {
    // La cascada de la BD no llega a Google Cloud Storage: sin esto, las fotos
    // del inventario se quedarían ahí para siempre y sin nadie que las
    // referenciara.
    const { action, removeAllForCompany } = build({ company: PRINCIPAL, branchIds: [] });

    await action.execute(8);

    expect(removeAllForCompany).toHaveBeenCalledWith(8);
  });

  it('limpia también las imágenes de las sucursales arrastradas', async () => {
    const { action, removeAllForCompany } = build({ company: PRINCIPAL, branchIds: ['12', '30'] });

    await action.execute(8);

    expect(removeAllForCompany.mock.calls.map(([id]) => id)).toEqual([8, 12, 30]);
  });

  it('borra todo en la MISMA transacción', async () => {
    const { action, dataSource, del } = build({ company: PRINCIPAL, branchIds: ['12'] });

    await action.execute(8);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('borrar una SUCURSAL no toca al negocio principal', async () => {
    const { action, del, query } = build({ company: SUCURSAL });

    await action.execute(12);

    expect(del).toHaveBeenCalledWith(['12']);
    // Ni siquiera busca sucursales: una sucursal no tiene sucursales debajo.
    expect(query).not.toHaveBeenCalled();
  });

  it('busca las sucursales por el owner del principal, no por la company', async () => {
    const { action, query } = build({ company: PRINCIPAL, branchIds: ['12'] });

    await action.execute(8);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('company_members');
    expect(sql).toContain('u.company_id = $1');
    expect(sql).toContain('c.is_branch = true');
    expect(query.mock.calls[0][1]).toEqual([8]);
  });
});
