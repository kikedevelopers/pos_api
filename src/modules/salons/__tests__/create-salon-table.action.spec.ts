import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';

import { CreateSalonTableAction } from '../actions/create-salon-table.action';
import { Salon } from '../entities/salon.entity';
import type { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';

describe('CreateSalonTableAction', () => {
  let action: CreateSalonTableAction;
  let createdInput: Partial<RestaurantTable> | null;

  const build = async (
    salon: Partial<Salon> | null,
    saveImpl: (t: RestaurantTable) => Promise<RestaurantTable> = (t) =>
      Promise.resolve({ ...t, id: '11' }),
  ) => {
    createdInput = null;
    const managerMock = {
      findOne: jest.fn((entity: unknown) =>
        entity === Salon ? Promise.resolve(salon) : Promise.resolve(null),
      ),
      create: jest.fn((_e: unknown, input: Partial<RestaurantTable>) => {
        createdInput = input;
        return input as RestaurantTable;
      }),
      save: jest.fn((_e: unknown, t: RestaurantTable) => saveImpl(t)),
    };
    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [CreateSalonTableAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    action = module.get(CreateSalonTableAction);
  };

  it('crea una mesa anclada permanentemente (owned_by_salon=true) al salón', async () => {
    await build({ id: '5', company_id: '42', is_archived: false });

    await action.execute(5, { name: 'Mesa 1', seats: 2 }, 42, { id: 1, fullName: 'X' });

    expect(createdInput?.salon_id).toBe('5');
    expect(createdInput?.owned_by_salon).toBe(true);
    expect(createdInput?.company_id).toBe('42');
  });

  it('404 si el salón no existe', async () => {
    await build(null);
    await expect(
      action.execute(5, { name: 'Mesa 1', seats: 2 }, 42, { id: 1, fullName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400 si el salón está archivado', async () => {
    await build({ id: '5', company_id: '42', is_archived: true });
    await expect(
      action.execute(5, { name: 'Mesa 1', seats: 2 }, 42, { id: 1, fullName: 'X' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('409 si el nombre de mesa choca (UNIQUE)', async () => {
    await build({ id: '5', company_id: '42', is_archived: false }, () => {
      const err = new QueryFailedError('q', [], new Error('dup')) as QueryFailedError & {
        code?: string;
      };
      err.code = '23505';
      return Promise.reject(err);
    });
    await expect(
      action.execute(5, { name: 'Mesa 1', seats: 2 }, 42, { id: 1, fullName: 'X' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
