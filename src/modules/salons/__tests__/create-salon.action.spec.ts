import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';

import { CreateSalonAction } from '../actions/create-salon.action';
import type { Salon } from '../entities/salon.entity';

describe('CreateSalonAction', () => {
  let action: CreateSalonAction;
  let createdInput: Partial<Salon> | null;

  const buildModule = async (saveImpl: (s: Salon) => Promise<Salon>) => {
    createdInput = null;
    const managerMock = {
      create: jest.fn((_e: unknown, input: Partial<Salon>) => {
        createdInput = input;
        return input as Salon;
      }),
      save: jest.fn((_e: unknown, salon: Salon) => saveImpl(salon)),
    };
    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [CreateSalonAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    action = module.get(CreateSalonAction);
  };

  it('crea el salón con name trimeado, is_archived=false y auditoría', async () => {
    await buildModule((s) =>
      Promise.resolve({ ...s, id: '7', created_at: new Date(), updated_at: new Date() }),
    );

    const result = await action.execute({ name: '  Sur A  ' }, 42, {
      id: 17,
      fullName: 'Kike Pacheco',
    });

    expect(createdInput?.company_id).toBe('42');
    expect(createdInput?.name).toBe('Sur A');
    expect(createdInput?.is_archived).toBe(false);
    expect(createdInput?.created_by).toBe('Kike Pacheco');
    expect(createdInput?.created_by_id).toBe('17');
    expect(result.id).toBe('7');
  });

  it('usa el companyId del parámetro, nunca del DTO', async () => {
    await buildModule((s) => Promise.resolve({ ...s, id: '1' }));
    await action.execute({ name: 'Sur A' }, 99, { id: 1, fullName: 'X' });
    expect(createdInput?.company_id).toBe('99');
  });

  it('400 si el nombre queda vacío tras trim', async () => {
    await buildModule((s) => Promise.resolve(s));
    await expect(
      action.execute({ name: '   ' }, 42, { id: 1, fullName: 'X' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('409 si el nombre choca (UNIQUE violation)', async () => {
    await buildModule(() => {
      const err = new QueryFailedError('q', [], new Error('dup')) as QueryFailedError & {
        code?: string;
      };
      err.code = '23505';
      return Promise.reject(err);
    });
    await expect(
      action.execute({ name: 'Sur A' }, 42, { id: 1, fullName: 'X' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('propaga un error NO-UNIQUE tal cual', async () => {
    const boom = new Error('boom');
    await buildModule(() => Promise.reject(boom));
    await expect(action.execute({ name: 'Sur A' }, 42, { id: 1, fullName: 'X' })).rejects.toBe(
      boom,
    );
  });
});
