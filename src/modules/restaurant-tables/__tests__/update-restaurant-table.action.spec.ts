import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';

import { UpdateRestaurantTableAction } from '../actions/update-restaurant-table.action';
import type { RestaurantTable } from '../entities/restaurant-table.entity';

describe('UpdateRestaurantTableAction', () => {
  let action: UpdateRestaurantTableAction;

  const build = async (
    table: Partial<RestaurantTable> | null,
    updateImpl: () => Promise<unknown> = () => Promise.resolve({ affected: 1 }),
  ) => {
    const manager = { findOne: jest.fn().mockResolvedValue(table), update: jest.fn(updateImpl) };
    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof manager) => Promise<T>) => cb(manager)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [UpdateRestaurantTableAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    action = module.get(UpdateRestaurantTableAction);
    return manager;
  };

  const ACTIVE = { id: '9', company_id: '42', is_archived: false, name: 'Mesa 1', seats: 4 };

  it('edita name y seats', async () => {
    const manager = await build({ ...ACTIVE });
    await action.execute(9, { name: '  Barra 1 ', seats: 6 }, 42);
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: '9', company_id: '42' },
      { name: 'Barra 1', seats: 6 },
    );
  });

  it('404 si no existe', async () => {
    await build(null);
    await expect(action.execute(9, { name: 'X' }, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 si está archivada', async () => {
    await build({ ...ACTIVE, is_archived: true });
    await expect(action.execute(9, { name: 'X' }, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400 si el name queda vacío', async () => {
    await build({ ...ACTIVE });
    await expect(action.execute(9, { name: '  ' }, 42)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([0, -1, 1.5])('400 si seats no es un entero >= 1 (%p)', async (seats) => {
    await build({ ...ACTIVE });
    await expect(action.execute(9, { seats }, 42)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('patch vacío devuelve la mesa sin tocar update', async () => {
    const existing = { ...ACTIVE } as RestaurantTable;
    const manager = await build(existing);
    const result = await action.execute(9, {}, 42);
    expect(manager.update).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('409 si el nombre choca (UNIQUE)', async () => {
    await build({ ...ACTIVE }, () => {
      const err = new QueryFailedError('q', [], new Error('dup')) as QueryFailedError & {
        code?: string;
      };
      err.code = '23505';
      return Promise.reject(err);
    });
    await expect(action.execute(9, { name: 'Mesa 2' }, 42)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('NO permite cambiar el anclaje (solo name/seats llegan al patch)', async () => {
    const manager = await build({ ...ACTIVE });
    await action.execute(9, { name: 'Mesa X', seats: 2 }, 42);
    const patch = (manager.update.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('salon_id');
    expect(patch).not.toHaveProperty('owned_by_salon');
  });
});
