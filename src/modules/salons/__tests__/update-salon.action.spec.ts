import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';

import { UpdateSalonAction } from '../actions/update-salon.action';
import type { Salon } from '../entities/salon.entity';

describe('UpdateSalonAction', () => {
  let action: UpdateSalonAction;

  const build = async (
    salon: Partial<Salon> | null,
    updateImpl: () => Promise<unknown> = () => Promise.resolve({ affected: 1 }),
  ) => {
    const manager = {
      findOne: jest.fn().mockResolvedValue(salon),
      update: jest.fn(updateImpl),
    };
    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof manager) => Promise<T>) => cb(manager)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [UpdateSalonAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    action = module.get(UpdateSalonAction);
    return manager;
  };

  it('renombra el salón (name trimeado)', async () => {
    const manager = await build({ id: '5', company_id: '42', is_archived: false, name: 'Sur A' });
    await action.execute(5, { name: '  Sur B  ' }, 42);
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: '5', company_id: '42' },
      { name: 'Sur B' },
    );
  });

  it('404 si no existe', async () => {
    await build(null);
    await expect(action.execute(5, { name: 'X' }, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 si está archivado', async () => {
    await build({ id: '5', company_id: '42', is_archived: true });
    await expect(action.execute(5, { name: 'X' }, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400 si el name queda vacío tras trim', async () => {
    await build({ id: '5', company_id: '42', is_archived: false });
    await expect(action.execute(5, { name: '   ' }, 42)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sin name (patch vacío) devuelve el salón sin tocar update', async () => {
    const existing = { id: '5', company_id: '42', is_archived: false, name: 'Sur A' } as Salon;
    const manager = await build(existing);
    const result = await action.execute(5, {}, 42);
    expect(manager.update).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('409 si el nombre choca (UNIQUE)', async () => {
    await build({ id: '5', company_id: '42', is_archived: false }, () => {
      const err = new QueryFailedError('q', [], new Error('dup')) as QueryFailedError & {
        code?: string;
      };
      err.code = '23505';
      return Promise.reject(err);
    });
    await expect(action.execute(5, { name: 'Sur B' }, 42)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
