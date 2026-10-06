import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';

import { FindAllRestaurantTablesAction } from '../actions/find-all-restaurant-tables.action';
import { RestaurantTable } from '../entities/restaurant-table.entity';

describe('FindAllRestaurantTablesAction', () => {
  const build = async () => {
    const repo = { find: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FindAllRestaurantTablesAction,
        { provide: getRepositoryToken(RestaurantTable), useValue: repo },
      ],
    }).compile();
    return { action: module.get(FindAllRestaurantTablesAction), repo };
  };

  it('scope all: todas las mesas activas de la company', async () => {
    const { action, repo } = await build();
    await action.execute(42, 'all');
    expect(repo.find).toHaveBeenCalledWith({
      where: { company_id: '42', is_archived: false },
      order: { name: 'ASC' },
    });
  });

  it('scope loose: solo las sueltas (salon_id IS NULL)', async () => {
    const { action, repo } = await build();
    await action.execute(42, 'loose');
    expect(repo.find).toHaveBeenCalledWith({
      where: { company_id: '42', is_archived: false, salon_id: IsNull() },
      order: { name: 'ASC' },
    });
  });

  it('scope por defecto es all', async () => {
    const { action, repo } = await build();
    await action.execute(42);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { company_id: '42', is_archived: false } }),
    );
  });
});
