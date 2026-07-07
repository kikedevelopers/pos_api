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

function buildAction(entities: unknown[], raw: unknown[], total: number) {
  const qb = makeQB(entities, raw, total);
  const repo = { createQueryBuilder: jest.fn(() => qb) };
  const action = new ListTenantsAction(repo as never);
  return { action, qb };
}

describe('ListTenantsAction · lastLogin', () => {
  const sub = { s_started_at: new Date('2026-06-01T00:00:00Z'), s_expires_at: new Date('2026-12-31T00:00:00Z') };

  it('proyecta lastLogin (ISO) desde owner.last_login', async () => {
    const lastLogin = new Date('2026-07-06T21:13:00.000Z');
    const owner = {
      id: '5',
      company_id: '8',
      name: 'Kike',
      lastname: 'Dev',
      email: 'kike@esenciaygrano.com',
      created_at: new Date('2026-06-01T00:00:00.000Z'),
      last_login: lastLogin,
      company: { id: '8', name: 'Esencia & Grano', document_number: 'J-1' },
    };
    const { action } = buildAction([owner], [sub], 1);

    const res = await action.execute({} as never);

    expect(res.total).toBe(1);
    expect(res.tenants[0].lastLogin).toBe(lastLogin.toISOString());
  });

  it('lastLogin es null cuando el owner nunca ha iniciado sesión', async () => {
    const owner = {
      id: '6',
      company_id: '9',
      name: 'Ana',
      lastname: 'Ruiz',
      email: 'ana@negocio.com',
      created_at: new Date('2026-06-10T00:00:00.000Z'),
      last_login: null,
      company: { id: '9', name: 'Negocio Ana', document_number: null },
    };
    const { action } = buildAction([owner], [sub], 1);

    const res = await action.execute({} as never);

    expect(res.tenants[0].lastLogin).toBeNull();
  });
});
