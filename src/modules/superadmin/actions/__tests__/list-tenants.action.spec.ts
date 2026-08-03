import { ListTenantsAction } from '../list-tenants.action';

/**
 * QueryBuilder mock: todos los métodos de la cadena devuelven el mismo QB.
 * `getCount` (usado sobre el clon) y `getRawAndEntities` resuelven los datos.
 */
function makeQB(entities: unknown[], raw: unknown[], total: number) {
  const qb: Record<string, jest.Mock> = {};
  const self = () => qb;
  for (const m of [
    'innerJoinAndSelect',
    'leftJoin',
    'where',
    'andWhere',
    'addSelect',
    'orderBy',
    'addOrderBy',
    'take',
    'skip',
  ]) {
    qb[m] = jest.fn(self);
  }
  qb.clone = jest.fn(() => qb);
  qb.getCount = jest.fn().mockResolvedValue(total);
  qb.getRawAndEntities = jest.fn().mockResolvedValue({ entities, raw });
  return qb;
}

/** Filas que devolvería la consulta de sucursales (company_members ⋈ companies). */
type BranchRow = {
  user_id: string;
  id: string;
  name: string;
  document_number: string | null;
  created_at: Date;
  is_active: boolean;
};

function buildAction(entities: unknown[], raw: unknown[], total: number, branches: BranchRow[] = []) {
  const qb = makeQB(entities, raw, total);
  const query = jest.fn().mockResolvedValue(branches);
  const repo = { createQueryBuilder: jest.fn(() => qb), manager: { query } };
  const action = new ListTenantsAction(repo as never);
  return { action, qb, query };
}

const sub = {
  s_started_at: new Date('2026-06-01T00:00:00Z'),
  s_expires_at: new Date('2026-12-31T00:00:00Z'),
};

const owner = {
  id: '5',
  company_id: '8',
  name: 'Kike',
  lastname: 'Dev',
  email: 'kike@esenciaygrano.com',
  created_at: new Date('2026-06-01T00:00:00.000Z'),
  last_login: new Date('2026-07-29T16:29:00.000Z'),
  company: { id: '8', name: 'Esencia & Grano', document_number: 'J-1' },
};

function branch(over: Partial<BranchRow> = {}): BranchRow {
  return {
    user_id: '5',
    id: '12',
    name: 'Esencia & Grano Sur',
    document_number: null,
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    is_active: true,
    ...over,
  };
}

describe('ListTenantsAction · lastLogin', () => {
  it('proyecta lastLogin (ISO) desde owner.last_login', async () => {
    const lastLogin = new Date('2026-07-06T21:13:00.000Z');
    const { action } = buildAction([{ ...owner, last_login: lastLogin }], [sub], 1);

    const res = await action.execute({});

    expect(res.total).toBe(1);
    expect(res.tenants[0].lastLogin).toBe(lastLogin.toISOString());
  });

  it('lastLogin es null cuando el owner nunca ha iniciado sesión', async () => {
    const ana = {
      id: '6',
      company_id: '9',
      name: 'Ana',
      lastname: 'Ruiz',
      email: 'ana@negocio.com',
      created_at: new Date('2026-06-10T00:00:00.000Z'),
      last_login: null,
      company: { id: '9', name: 'Negocio Ana', document_number: null },
    };
    const { action } = buildAction([ana], [sub], 1);

    const res = await action.execute({});

    expect(res.tenants[0].lastLogin).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sucursales en el listado.
//
// Una sucursal no tiene fila en `users`, así que el query de owners nunca la
// vería: se trae aparte y se intercala bajo su negocio principal. El panel las
// pinta como filas hijas, así que el ORDEN del array es parte del contrato.
// ---------------------------------------------------------------------------
describe('ListTenantsAction · sucursales', () => {
  it('sin sucursales, el listado no cambia y branchCount es 0', async () => {
    const { action } = buildAction([owner], [sub], 1, []);

    const res = await action.execute({});

    expect(res.tenants).toHaveLength(1);
    expect(res.tenants[0].isBranch).toBe(false);
    expect(res.tenants[0].parentCompanyId).toBeNull();
    expect(res.branchCount).toBe(0);
  });

  it('coloca la sucursal INMEDIATAMENTE debajo de su negocio principal', async () => {
    const { action } = buildAction([owner], [sub], 1, [branch()]);

    const res = await action.execute({});

    expect(res.tenants.map((t) => [t.companyName, t.isBranch])).toEqual([
      ['Esencia & Grano', false],
      ['Esencia & Grano Sur', true],
    ]);
    expect(res.branchCount).toBe(1);
  });

  it('la sucursal apunta a su principal y hereda owner', async () => {
    const { action } = buildAction([owner], [sub], 1, [branch()]);

    const res = await action.execute({});
    const suc = res.tenants[1];

    expect(suc.companyId).toBe(12);
    expect(suc.parentCompanyId).toBe(8);
    expect(suc.parentCompanyName).toBe('Esencia & Grano');
    expect(suc.ownerName).toBe('Kike Dev');
    expect(suc.ownerEmail).toBe('kike@esenciaygrano.com');
  });

  it('la sucursal NO trae suscripción propia (la hereda del principal)', async () => {
    // null ≠ "sin suscripción": el panel lo pinta como "Heredada". Si aquí se
    // copiaran las fechas del principal, la UI mostraría dos vigencias distintas
    // para una misma licencia.
    const { action } = buildAction([owner], [sub], 1, [branch()]);

    const res = await action.execute({});

    expect(res.tenants[0].subscriptionExpiresAt).toBe(sub.s_expires_at.toISOString());
    expect(res.tenants[1].subscriptionStartedAt).toBeNull();
    expect(res.tenants[1].subscriptionExpiresAt).toBeNull();
  });

  it('usa la fecha de creación de la SUCURSAL, no la del owner', async () => {
    const { action } = buildAction([owner], [sub], 1, [branch()]);

    const res = await action.execute({});

    expect(res.tenants[1].createdAt).toBe(new Date('2026-07-01T00:00:00.000Z').toISOString());
  });

  it('respeta el orden por antigüedad que devuelve la consulta (más vieja primero)', async () => {
    const { action } = buildAction(
      [owner],
      [sub],
      1,
      [
        branch({ id: '12', name: 'Sucursal Norte', created_at: new Date('2026-06-15T00:00:00Z') }),
        branch({ id: '30', name: 'Sucursal Sur', created_at: new Date('2026-07-20T00:00:00Z') }),
      ],
    );

    const res = await action.execute({});

    expect(res.tenants.map((t) => t.companyName)).toEqual([
      'Esencia & Grano',
      'Sucursal Norte',
      'Sucursal Sur',
    ]);
  });

  it('ordena por created_at ASC en SQL (el orden no puede depender del id)', async () => {
    const { action, query } = buildAction([owner], [sub], 1, [branch()]);

    await action.execute({});

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('c.is_branch = true');
    expect(sql).toMatch(/ORDER BY\s+c\.created_at ASC/);
  });

  it('agrupa cada sucursal bajo SU owner, no bajo el primero de la página', async () => {
    const ana = {
      id: '6',
      company_id: '9',
      name: 'Ana',
      lastname: 'Ruiz',
      email: 'ana@negocio.com',
      created_at: new Date('2026-06-10T00:00:00.000Z'),
      last_login: null,
      company: { id: '9', name: 'Negocio Ana', document_number: null },
    };
    const { action } = buildAction(
      [owner, ana],
      [sub, sub],
      2,
      [
        branch({ user_id: '5', id: '12', name: 'Sucursal de Kike' }),
        branch({ user_id: '6', id: '13', name: 'Sucursal de Ana' }),
      ],
    );

    const res = await action.execute({});

    expect(res.tenants.map((t) => t.companyName)).toEqual([
      'Esencia & Grano',
      'Sucursal de Kike',
      'Negocio Ana',
      'Sucursal de Ana',
    ]);
    expect(res.tenants[3].parentCompanyId).toBe(9);
  });

  it('propaga el estado activa/suspendida de la membresía', async () => {
    const { action } = buildAction([owner], [sub], 1, [branch({ is_active: false })]);

    const res = await action.execute({});

    expect(res.tenants[0].active).toBe(true); // el principal nunca se suspende
    expect(res.tenants[1].active).toBe(false);
  });

  it('la paginación cuenta CUENTAS, no filas: total ignora las sucursales', async () => {
    const { action } = buildAction([owner], [sub], 1, [branch(), branch({ id: '13' })]);

    const res = await action.execute({});

    expect(res.total).toBe(1);
    expect(res.tenants).toHaveLength(3);
    expect(res.branchCount).toBe(2);
  });

  it('sin owners en la página no consulta sucursales (evita el round-trip)', async () => {
    const { action, query } = buildAction([], [], 0, []);

    const res = await action.execute({});

    expect(res.tenants).toEqual([]);
    expect(res.branchCount).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Búsqueda de grupo: quien escribe el nombre de una sucursal está buscando ese
// negocio, no una fila suelta. El resultado debe traer el grupo entero.
// ---------------------------------------------------------------------------
describe('ListTenantsAction · búsqueda', () => {
  it('extiende el filtro a los nombres de las sucursales del owner', async () => {
    const { action, qb } = buildAction([owner], [sub], 1, [branch()]);

    await action.execute({ search: 'Sur' });

    const where = String(qb.andWhere.mock.calls[0][0]);
    expect(where).toContain('EXISTS');
    expect(where).toContain('company_members');
    expect(where).toContain('bc.is_branch = true');
    expect(where).toContain('bc.name ILIKE :s');
    // Y sigue buscando por owner y negocio principal.
    expect(where).toContain('u.email ILIKE :s');
    expect(where).toContain('c.name ILIKE :s');
    expect(qb.andWhere.mock.calls[0][1]).toEqual({ s: '%Sur%' });
  });

  it('buscar la sucursal devuelve TAMBIÉN a su negocio principal', async () => {
    // El EXISTS hace que el owner matchee; sus sucursales viajan con él.
    const { action } = buildAction([owner], [sub], 1, [branch({ name: 'Sucursal Sur' })]);

    const res = await action.execute({ search: 'Sucursal Sur' });

    expect(res.tenants.map((t) => t.companyName)).toEqual([
      'Esencia & Grano',
      'Sucursal Sur',
    ]);
  });

  it('sin búsqueda no añade filtros', async () => {
    const { action, qb } = buildAction([owner], [sub], 1);

    await action.execute({});

    expect(qb.andWhere).not.toHaveBeenCalled();
  });
});
