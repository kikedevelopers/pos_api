import type { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';

import { ResolveAiActorAction } from '../actions/resolve-ai-actor.action';

/**
 * Negocios del owner en el actor de Place: salen de `company_members` por el
 * `user_id` del JWT (da igual desde qué negocio esté conectado) y SOLO para el
 * owner. Es la base del alcance por `business_id`, así que también es la
 * barrera anti-IDOR.
 */
describe('ResolveAiActorAction · negocios del owner', () => {
  const MEMBERS_SQL = /FROM company_members/;

  const build = (
    memberRows: Array<{ id: string; name: string | null; is_branch: boolean; is_active: boolean }>,
  ): { action: ResolveAiActorAction; query: jest.Mock } => {
    const query = jest.fn((sql: string) => {
      if (MEMBERS_SQL.test(sql)) {
        return Promise.resolve(memberRows);
      }
      if (/FROM companies WHERE id/.test(sql)) {
        return Promise.resolve([{ name: 'Surtidor La 21' }]);
      }
      return Promise.resolve([]);
    });
    const action = new ResolveAiActorAction(
      { query } as unknown as DataSource,
      { execute: jest.fn().mockResolvedValue([]) } as unknown as ResolveEffectivePermissionsAction,
    );
    return { action, query };
  };

  const user = (over: Partial<AuthUser> = {}): AuthUser =>
    ({
      type: 'owner',
      account: 'user',
      user_id: 1,
      name: 'Kike',
      lastname: 'D',
      ...over,
    }) as AuthUser;

  const ROWS = [
    { id: '10', name: 'Surtidor La 21', is_branch: false, is_active: true },
    { id: '11', name: ' Sucursal Norte ', is_branch: true, is_active: true },
    { id: '12', name: null, is_branch: true, is_active: false },
  ];

  it('owner: devuelve sus negocios normalizados (principal primero) desde cualquier negocio', async () => {
    const { action, query } = build(ROWS);
    const actor = await action.execute(user(), 11);

    expect(actor.businesses).toEqual([
      { id: 10, name: 'Surtidor La 21', is_branch: false, is_active: true },
      { id: 11, name: 'Sucursal Norte', is_branch: true, is_active: true },
      { id: 12, name: 'Negocio #12', is_branch: true, is_active: false },
    ]);
    const calls = query.mock.calls as Array<[string, unknown[]]>;
    const membersCall = calls.find(([sql]) => MEMBERS_SQL.test(sql));
    expect(membersCall?.[1]).toEqual(['1']);
  });

  it.each(['superadmin', 'manager', 'employee'] as const)(
    '%s: sin negocios y sin consultar company_members',
    async (type) => {
      const { action, query } = build(ROWS);
      const actor = await action.execute(user({ type, account: 'user' }), 10);
      expect(actor.businesses).toEqual([]);
      const calls = query.mock.calls as Array<[string, unknown[]]>;
      expect(calls.some(([sql]) => MEMBERS_SQL.test(sql))).toBe(false);
    },
  );

  it('owner sin membresías (cuenta antigua): solo el negocio actual', async () => {
    const { action } = build([]);
    const actor = await action.execute(user(), 10);
    expect(actor.businesses).toEqual([
      { id: 10, name: 'Surtidor La 21', is_branch: false, is_active: true },
    ]);
  });

  it('si el negocio de la sesión no está entre sus membresías, no se le abre ningún otro', async () => {
    const { action } = build(ROWS);
    const actor = await action.execute(user(), 99);
    expect(actor.businesses).toEqual([
      { id: 99, name: 'Surtidor La 21', is_branch: false, is_active: true },
    ]);
  });
});
