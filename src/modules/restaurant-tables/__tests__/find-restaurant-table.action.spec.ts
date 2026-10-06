import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { FindRestaurantTableAction } from '../actions/find-restaurant-table.action';
import { RestaurantTable } from '../entities/restaurant-table.entity';

describe('FindRestaurantTableAction', () => {
  const build = async (table: Partial<RestaurantTable> | null) => {
    const repo = { manager: { findOne: jest.fn().mockResolvedValue(table) } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FindRestaurantTableAction,
        { provide: getRepositoryToken(RestaurantTable), useValue: repo },
      ],
    }).compile();
    return { action: module.get(FindRestaurantTableAction), repo };
  };

  it('devuelve la mesa de la company', async () => {
    const { action, repo } = await build({ id: '9', company_id: '42' });
    const result = await action.execute(9, 42);
    expect(result.id).toBe('9');
    expect(repo.manager.findOne).toHaveBeenCalledWith(RestaurantTable, {
      where: { id: '9', company_id: '42' },
    });
  });

  it('404 si no existe o es de otra company (anti-enumeración)', async () => {
    const { action } = await build(null);
    await expect(action.execute(9, 42)).rejects.toBeInstanceOf(NotFoundException);
  });
});
