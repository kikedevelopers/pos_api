import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';

import { CreateCustomerCategoryAction } from '../actions/create-customer-category.action';
import type { CustomerCategory } from '../entities/customer-category.entity';
import { IDX_CUSTOMER_CATEGORY_NAME_UNIQUE } from '../internal/constraint-errors';

/**
 * Tests unitarios de `CreateCustomerCategoryAction`.
 *
 * Cubre:
 *   - Happy path: crea con name trimeado, is_archived=false y auditoría.
 *   - `company_id` viene del parámetro, no del DTO.
 *   - `created_by`/`created_by_id` se congelan desde el actor.
 *   - 400 si el nombre queda vacío tras trim.
 *   - 409 si el índice único parcial choca (nombre duplicado).
 *   - Un error NO-UNIQUE se propaga tal cual (no se traga).
 */
describe('CreateCustomerCategoryAction', () => {
  let action: CreateCustomerCategoryAction;
  let createdInput: Partial<CustomerCategory> | null;
  let savedCategory: CustomerCategory | null;
  let saveImpl: (category: CustomerCategory) => Promise<CustomerCategory>;

  beforeEach(async () => {
    createdInput = null;
    savedCategory = null;
    saveImpl = (category) => {
      savedCategory = {
        ...category,
        id: '10',
        created_at: new Date('2026-09-25T14:30:00.000Z'),
        updated_at: new Date('2026-09-25T14:30:00.000Z'),
      };
      return Promise.resolve(savedCategory);
    };

    const managerMock = {
      create: jest.fn((_entity: unknown, input: Partial<CustomerCategory>) => {
        createdInput = input;
        return input as CustomerCategory;
      }),
      save: jest.fn((_entity: unknown, category: CustomerCategory) => saveImpl(category)),
    };

    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CreateCustomerCategoryAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(CreateCustomerCategoryAction);
  });

  it('crea la categoría con name trimeado, is_archived=false y auditoría', async () => {
    const result = await action.execute({ name: '  Cliente Redes Sociales  ' }, 42, {
      id: 17,
      fullName: 'Kike Pacheco',
    });

    expect(createdInput?.company_id).toBe('42');
    expect(createdInput?.name).toBe('Cliente Redes Sociales');
    expect(createdInput?.is_archived).toBe(false);
    expect(createdInput?.created_by).toBe('Kike Pacheco');
    expect(createdInput?.created_by_id).toBe('17');
    expect(result).toBe(savedCategory);
    expect(result.id).toBe('10');
  });

  it('asigna company_id desde el parámetro, nunca del DTO', async () => {
    await action.execute({ name: 'Clientes Pueblos' }, 7, { id: 1, fullName: 'Owner' });
    expect(createdInput?.company_id).toBe('7');
  });

  it('lanza 400 si el nombre queda vacío tras trim', async () => {
    await expect(
      action.execute({ name: '   ' }, 1, { id: 1, fullName: 'Owner' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(savedCategory).toBeNull();
  });

  it('traduce la violación UNIQUE a 409 CUSTOMER_CATEGORY_NAME_TAKEN', async () => {
    saveImpl = () => {
      const err = new QueryFailedError('query', [], new Error('dup'));
      Object.assign(err, {
        code: '23505',
        constraint: IDX_CUSTOMER_CATEGORY_NAME_UNIQUE,
      });
      return Promise.reject(err);
    };

    await expect(
      action.execute({ name: 'Duplicada' }, 1, { id: 1, fullName: 'Owner' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('propaga un error que NO es violación UNIQUE', async () => {
    saveImpl = () => Promise.reject(new Error('boom'));

    await expect(action.execute({ name: 'X' }, 1, { id: 1, fullName: 'Owner' })).rejects.toThrow(
      'boom',
    );
  });
});
