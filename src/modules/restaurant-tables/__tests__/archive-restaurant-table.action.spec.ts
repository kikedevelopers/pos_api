import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { ArchiveRestaurantTableAction } from '../actions/archive-restaurant-table.action';
import type { RestaurantTable } from '../entities/restaurant-table.entity';

describe('ArchiveRestaurantTableAction', () => {
  let action: ArchiveRestaurantTableAction;

  const build = async (table: Partial<RestaurantTable> | null) => {
    const manager = {
      findOne: jest.fn().mockResolvedValue(table),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof manager) => Promise<T>) => cb(manager)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [ArchiveRestaurantTableAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    action = module.get(ArchiveRestaurantTableAction);
    return manager;
  };

  it('archiva la mesa (is_archived=true)', async () => {
    const manager = await build({ id: '9', company_id: '42', is_archived: false });
    const result = await action.execute(9, 42);
    expect(result).toEqual({ archived: true });
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: '9', company_id: '42' },
      { is_archived: true },
    );
  });

  it('404 si no existe', async () => {
    await build(null);
    await expect(action.execute(9, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 si ya está archivada', async () => {
    await build({ id: '9', company_id: '42', is_archived: true });
    await expect(action.execute(9, 42)).rejects.toBeInstanceOf(NotFoundException);
  });
});
