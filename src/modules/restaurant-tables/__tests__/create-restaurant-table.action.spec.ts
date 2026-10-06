import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';

import { CreateRestaurantTableAction } from '../actions/create-restaurant-table.action';
import type { RestaurantTable } from '../entities/restaurant-table.entity';

describe('CreateRestaurantTableAction', () => {
  let action: CreateRestaurantTableAction;
  let createdInput: Partial<RestaurantTable> | null;

  const build = async (saveImpl: (t: RestaurantTable) => Promise<RestaurantTable>) => {
    createdInput = null;
    const managerMock = {
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
      providers: [CreateRestaurantTableAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    action = module.get(CreateRestaurantTableAction);
  };

  it('crea una mesa SUELTA: salon_id null, owned_by_salon false, status free', async () => {
    await build((t) => Promise.resolve({ ...t, id: '3' }));

    await action.execute({ name: '  Mesa 1  ', seats: 4 }, 42, {
      id: 17,
      fullName: 'Kike Pacheco',
    });

    expect(createdInput?.company_id).toBe('42');
    expect(createdInput?.name).toBe('Mesa 1');
    expect(createdInput?.seats).toBe(4);
    expect(createdInput?.salon_id).toBeNull();
    expect(createdInput?.owned_by_salon).toBe(false);
    expect(createdInput?.status).toBe('free');
    expect(createdInput?.created_by_id).toBe('17');
  });

  it('400 si el nombre queda vacío', async () => {
    await build((t) => Promise.resolve(t));
    await expect(
      action.execute({ name: '  ', seats: 4 }, 42, { id: 1, fullName: 'X' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('409 si el nombre choca (UNIQUE)', async () => {
    await build(() => {
      const err = new QueryFailedError('q', [], new Error('d')) as QueryFailedError & {
        code?: string;
      };
      err.code = '23505';
      return Promise.reject(err);
    });
    await expect(
      action.execute({ name: 'Mesa 1', seats: 4 }, 42, { id: 1, fullName: 'X' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
