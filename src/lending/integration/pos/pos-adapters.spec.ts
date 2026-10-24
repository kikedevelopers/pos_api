import { In } from 'typeorm';

import { PosCustomersAdapter } from './pos-customers.adapter';
import { PosTenantAdapter } from './pos-tenant.adapter';

const dataSourceWith = (overrides: { findOne?: jest.Mock; find?: jest.Mock; repoFindOne?: jest.Mock }) =>
  ({
    manager: { findOne: overrides.findOne ?? jest.fn(), find: overrides.find ?? jest.fn() },
    getRepository: () => ({ findOne: overrides.repoFindOne ?? jest.fn() }),
  }) as never;

describe('PosTenantAdapter', () => {
  it.each([
    ['lender', true],
    ['retail', false],
    ['restaurant', false],
    ['desconocido', false],
  ])('pos_mode %s → prestamista %s', async (pos_mode, expected) => {
    const repoFindOne = jest.fn().mockResolvedValue({ id: '42', pos_mode });
    expect(await new PosTenantAdapter(dataSourceWith({ repoFindOne })).isLender(42)).toBe(expected);
    expect(repoFindOne).toHaveBeenCalledWith({ where: { id: '42' }, select: { id: true, pos_mode: true } });
  });

  it('company inexistente: no es prestamista', async () => {
    const repoFindOne = jest.fn().mockResolvedValue(null);
    expect(await new PosTenantAdapter(dataSourceWith({ repoFindOne })).isLender(42)).toBe(false);
  });
});

describe('PosCustomersAdapter', () => {
  it('findActive: solo activos de la company, con la transacción si llega', async () => {
    const findOne = jest.fn().mockResolvedValue({ id: '5', name: 'ALONSO REYES' });
    const tx = { findOne } as never;
    const adapter = new PosCustomersAdapter(dataSourceWith({}));
    expect(await adapter.findActive(42, 5, tx)).toEqual({ id: 5, name: 'ALONSO REYES' });
    expect(findOne.mock.calls[0][1]).toMatchObject({
      where: { id: '5', company_id: '42', is_archived: false },
    });
  });

  it('findActive: sin cliente → null; sin transacción usa el manager', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    expect(await new PosCustomersAdapter(dataSourceWith({ findOne })).findActive(42, 9)).toBeNull();
    expect(findOne).toHaveBeenCalled();
  });

  it('namesByIds: una consulta por company con ids únicos; vacío no consulta', async () => {
    const find = jest.fn().mockResolvedValue([
      { id: '5', name: 'ALONSO REYES' },
      { id: '7', name: 'MAURI ESPITIA' },
    ]);
    const adapter = new PosCustomersAdapter(dataSourceWith({ find }));
    const names = await adapter.namesByIds(42, [5, 7, 5]);
    expect([...names.entries()]).toEqual([
      [5, 'ALONSO REYES'],
      [7, 'MAURI ESPITIA'],
    ]);
    expect(find.mock.calls[0][1].where).toEqual({ company_id: '42', id: In(['5', '7']) });

    find.mockClear();
    expect((await adapter.namesByIds(42, [])).size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });
});
