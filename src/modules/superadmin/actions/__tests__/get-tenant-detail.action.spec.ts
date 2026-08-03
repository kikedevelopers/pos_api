import { NotFoundException } from '@nestjs/common';

import { GetTenantDetailAction } from '../get-tenant-detail.action';

// ---------------------------------------------------------------------------
// Detalle de un tenant, con foco en las SUCURSALES.
//
// Una sucursal es una company completa en datos, pero no tiene identidad
// propia: ni fila en `users` ni suscripción. Antes de esto, abrir una sucursal
// en el panel la mostraba como una cuenta huérfana —sin propietario y sin
// vigencia—, cuando en realidad está cubierta por su negocio principal.
// ---------------------------------------------------------------------------

const PRINCIPAL = {
  id: '8',
  name: 'Esencia & Grano',
  document_number: 'J-1',
  address: null,
  email: null,
  phone_number: null,
  origin: 'web',
  created_at: new Date('2026-06-01T00:00:00.000Z'),
  is_branch: false,
};

const SUCURSAL = {
  ...PRINCIPAL,
  id: '12',
  name: 'Esencia & Grano Sur',
  created_at: new Date('2026-07-01T00:00:00.000Z'),
  is_branch: true,
};

const OWNER = {
  id: '5',
  company_id: '8',
  name: 'Enrique',
  lastname: 'Pacheco',
  email: 'kike@esenciaygrano.com',
  last_login: new Date('2026-07-29T16:29:00.000Z'),
  branches_enabled: true,
  branches_allowed: 1,
};

const SUB = {
  started_at: new Date('2026-06-01T00:00:00.000Z'),
  expires_at: new Date('2026-12-31T00:00:00.000Z'),
};

interface Options {
  company: Record<string, unknown> | null;
  /** Owner con `users.company_id` = esta company (null en una sucursal). */
  directOwner?: Record<string, unknown> | null;
  directSubscription?: Record<string, unknown> | null;
  /** Owner alcanzado por membresía (el del principal). */
  membershipOwner?: Record<string, unknown> | null;
  parentCompany?: Record<string, unknown> | null;
  parentSubscription?: Record<string, unknown> | null;
  /** Filas de company_members que devuelve la búsqueda del owner de la sucursal. */
  memberRows?: Array<{ user_id: string }>;
}

function build(opts: Options) {
  const companyRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) => {
      if (where.id === String(opts.company?.id)) return Promise.resolve(opts.company);
      return Promise.resolve(opts.parentCompany ?? null);
    }),
    manager: {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM company_members cm\n       WHERE cm.company_id')) {
          return Promise.resolve(opts.memberRows ?? []);
        }
        // Gating de sucursales del owner.
        if (sql.includes('COUNT(*) FILTER')) {
          return Promise.resolve([{ count: '1', active_count: '1' }]);
        }
        // COUNT por dominio.
        return Promise.resolve([{ count: '0' }]);
      }),
    },
  };

  const userRepo = {
    findOne: jest.fn(({ where }: { where: { id?: string; company_id?: string } }) => {
      if (where.id) return Promise.resolve(opts.membershipOwner ?? null);
      return Promise.resolve(opts.directOwner ?? null);
    }),
  };

  const subscriptionRepo = {
    findOne: jest.fn(({ where }: { where: { company_id: string } }) => {
      if (where.company_id === String(opts.company?.id)) {
        return Promise.resolve(opts.directSubscription ?? null);
      }
      return Promise.resolve(opts.parentSubscription ?? null);
    }),
  };

  return new GetTenantDetailAction(companyRepo as never, userRepo as never, subscriptionRepo as never);
}

describe('GetTenantDetailAction · negocio principal', () => {
  it('devuelve owner y suscripción propios, sin parent', async () => {
    const action = build({
      company: PRINCIPAL,
      directOwner: OWNER,
      directSubscription: SUB,
    });

    const res = await action.execute(8);

    expect(res.company.isBranch).toBe(false);
    expect(res.parent).toBeNull();
    expect(res.owner?.email).toBe('kike@esenciaygrano.com');
    expect(res.subscription?.expiresAt).toBe(SUB.expires_at.toISOString());
  });

  it('404 si la company no existe', async () => {
    const action = build({ company: null });

    await expect(action.execute(999)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GetTenantDetailAction · sucursal', () => {
  const branchOpts: Options = {
    company: SUCURSAL,
    directOwner: null,
    directSubscription: null,
    memberRows: [{ user_id: '5' }],
    membershipOwner: OWNER,
    parentCompany: PRINCIPAL,
    parentSubscription: SUB,
  };

  it('se marca como sucursal', async () => {
    const res = await build(branchOpts).execute(12);

    expect(res.company.isBranch).toBe(true);
    expect(res.company.name).toBe('Esencia & Grano Sur');
  });

  it('informa cuál es su negocio principal', async () => {
    const res = await build(branchOpts).execute(12);

    expect(res.parent).toEqual({ id: 8, name: 'Esencia & Grano' });
  });

  it('hereda el owner del principal (no tiene usuario propio)', async () => {
    const res = await build(branchOpts).execute(12);

    expect(res.owner).not.toBeNull();
    expect(res.owner?.email).toBe('kike@esenciaygrano.com');
    expect(res.owner?.lastLogin).toBe(OWNER.last_login.toISOString());
  });

  it('hereda la suscripción del principal (no tiene vigencia propia)', async () => {
    const res = await build(branchOpts).execute(12);

    expect(res.subscription).toEqual({
      startedAt: SUB.started_at.toISOString(),
      expiresAt: SUB.expires_at.toISOString(),
      active: true,
    });
  });

  it('los conteos siguen siendo los SUYOS, no los del principal', async () => {
    // El aislamiento por company_id no cambia: lo heredado es la identidad
    // (owner/suscripción), nunca los datos de negocio.
    const action = build(branchOpts);

    const res = await action.execute(12);

    expect(res.counts).toEqual({
      ventas: 0,
      compras: 0,
      clientes: 0,
      productos: 0,
      proveedores: 0,
      gastos: 0,
    });
  });

  it('sin membresía (dato inconsistente) no revienta: devuelve el detalle sin herencia', async () => {
    const res = await build({ ...branchOpts, memberRows: [] }).execute(12);

    expect(res.company.isBranch).toBe(true);
    expect(res.parent).toBeNull();
    expect(res.owner).toBeNull();
    expect(res.subscription).toBeNull();
  });

  it('si el owner de la membresía ya no existe, tampoco revienta', async () => {
    const res = await build({ ...branchOpts, membershipOwner: null }).execute(12);

    expect(res.parent).toBeNull();
    expect(res.owner).toBeNull();
  });

  it('owner sin company_id: se devuelve el owner pero sin parent ni suscripción', async () => {
    const res = await build({
      ...branchOpts,
      membershipOwner: { ...OWNER, company_id: null },
    }).execute(12);

    expect(res.owner?.email).toBe('kike@esenciaygrano.com');
    expect(res.parent).toBeNull();
    expect(res.subscription).toBeNull();
  });

  it('una suscripción vencida se refleja como inactiva', async () => {
    const res = await build({
      ...branchOpts,
      parentSubscription: {
        started_at: new Date('2024-01-01T00:00:00.000Z'),
        expires_at: new Date('2024-12-31T00:00:00.000Z'),
      },
    }).execute(12);

    expect(res.subscription?.active).toBe(false);
  });
});
