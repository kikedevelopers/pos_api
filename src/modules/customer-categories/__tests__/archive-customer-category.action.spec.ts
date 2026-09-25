import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { ArchiveCustomerCategoryAction } from '../actions/archive-customer-category.action';
import { CustomerCategory } from '../entities/customer-category.entity';

/**
 * Tests unitarios de `ArchiveCustomerCategoryAction`.
 *
 * Cubre:
 *   - Happy path: setea is_archived=true y devuelve { archived: true }.
 *   - 404 si no existe.
 *   - 404 si YA está archivada (solo archiva, no des-archiva).
 */
describe('ArchiveCustomerCategoryAction', () => {
  let action: ArchiveCustomerCategoryAction;
  let existing: CustomerCategory | null;
  let updateMock: jest.Mock;

  beforeEach(async () => {
    existing = {
      id: '5',
      company_id: '1',
      name: 'Clientes Pueblos',
      is_archived: false,
    } as CustomerCategory;
    updateMock = jest.fn(() => Promise.resolve({ affected: 1 }));

    const managerMock = {
      findOne: jest.fn(() => Promise.resolve(existing)),
      update: updateMock,
    };
    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ArchiveCustomerCategoryAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(ArchiveCustomerCategoryAction);
  });

  it('archiva y devuelve { archived: true }', async () => {
    const result = await action.execute(5, 1);
    expect(updateMock).toHaveBeenCalledWith(
      CustomerCategory,
      { id: '5', company_id: '1' },
      { is_archived: true },
    );
    expect(result).toEqual({ archived: true });
  });

  it('lanza 404 si no existe', async () => {
    existing = null;
    await expect(action.execute(999, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('lanza 404 si ya está archivada', async () => {
    existing = { ...(existing as CustomerCategory), is_archived: true };
    await expect(action.execute(5, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
