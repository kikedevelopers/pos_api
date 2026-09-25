import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';

import { UpdateCustomerCategoryAction } from '../actions/update-customer-category.action';
import { CustomerCategory } from '../entities/customer-category.entity';
import { IDX_CUSTOMER_CATEGORY_NAME_UNIQUE } from '../internal/constraint-errors';

/**
 * Tests unitarios de `UpdateCustomerCategoryAction`.
 *
 * Cubre:
 *   - Renombra (patch aplicado + re-fetch).
 *   - 404 si no existe.
 *   - 404 si está archivada (no se renombra una archivada).
 *   - 400 si `name` viene pero queda blank.
 *   - No-op (`{}`) devuelve la existente sin UPDATE.
 *   - 409 en colisión de nombre.
 */
describe('UpdateCustomerCategoryAction', () => {
  let action: UpdateCustomerCategoryAction;
  let existing: CustomerCategory | null;
  let updateMock: jest.Mock;
  let findOneCalls: number;

  const buildExisting = (over: Partial<CustomerCategory> = {}): CustomerCategory =>
    ({
      id: '5',
      company_id: '1',
      name: 'Original',
      is_archived: false,
      created_by: 'Owner',
      created_by_id: '1',
      created_at: new Date('2026-09-25T14:30:00.000Z'),
      updated_at: new Date('2026-09-25T14:30:00.000Z'),
      ...over,
    }) as CustomerCategory;

  beforeEach(async () => {
    existing = buildExisting();
    findOneCalls = 0;
    updateMock = jest.fn(() => Promise.resolve({ affected: 1 }));

    const managerMock = {
      findOne: jest.fn(() => {
        findOneCalls += 1;
        // Primera llamada: pre-check. Segunda: re-fetch tras el UPDATE.
        if (findOneCalls === 2 && existing) {
          return Promise.resolve(buildExisting({ name: 'Renombrada' }));
        }
        return Promise.resolve(existing);
      }),
      update: updateMock,
    };

    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UpdateCustomerCategoryAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(UpdateCustomerCategoryAction);
  });

  it('renombra y devuelve el re-fetch', async () => {
    const result = await action.execute(5, { name: '  Renombrada  ' }, 1);
    expect(updateMock).toHaveBeenCalledWith(
      CustomerCategory,
      { id: '5', company_id: '1' },
      { name: 'Renombrada' },
    );
    expect(result.name).toBe('Renombrada');
  });

  it('lanza 404 si no existe', async () => {
    existing = null;
    await expect(action.execute(999, { name: 'X' }, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('lanza 404 si está archivada', async () => {
    existing = buildExisting({ is_archived: true });
    await expect(action.execute(5, { name: 'X' }, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('lanza 400 si el name viene pero queda blank', async () => {
    await expect(action.execute(5, { name: '   ' }, 1)).rejects.toBeInstanceOf(BadRequestException);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('no-op con body vacío: devuelve la existente sin UPDATE', async () => {
    const result = await action.execute(5, {}, 1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('traduce la violación UNIQUE a 409', async () => {
    updateMock.mockImplementation(() => {
      const err = new QueryFailedError('query', [], new Error('dup'));
      Object.assign(err, { code: '23505', constraint: IDX_CUSTOMER_CATEGORY_NAME_UNIQUE });
      return Promise.reject(err);
    });
    await expect(action.execute(5, { name: 'Duplicada' }, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
