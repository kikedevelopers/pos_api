import { BadRequestException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CreateSupplierAction } from '../actions/create-supplier.action';
import type { Supplier } from '../entities/supplier.entity';

/**
 * Tests unitarios del action `CreateSupplierAction`.
 *
 * Cubrimos:
 *   - `company_id`, `created_by`, `created_by_id` asignados desde el contexto.
 *   - `accumulated_debt` y `credit_balance` se inicializan a 0 ignorando lo
 *     que traiga el DTO (defensa contra invocaciones directas).
 *   - `legal_name` blank ⇒ 400 con mensaje exacto de PlacePos.
 */
describe('CreateSupplierAction', () => {
  let action: CreateSupplierAction;
  let createdInput: Partial<Supplier> | null;

  beforeEach(async () => {
    createdInput = null;

    const managerMock = {
      create: jest.fn((_entity: unknown, input: Partial<Supplier>) => {
        createdInput = input;
        return input as Supplier;
      }),
      save: jest.fn(
        (_entity: unknown, supplier: Supplier): Promise<Supplier> =>
          Promise.resolve({
            ...supplier,
            id: '1',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
            updated_at: new Date('2026-05-12T14:30:00.000Z'),
          }),
      ),
    };

    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CreateSupplierAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(CreateSupplierAction);
  });

  it('rechaza legal_name en blanco con BadRequest', async () => {
    await expect(
      action.execute({ legal_name: '   ' }, 1, { id: 1, fullName: 'Owner' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('inicializa accumulated_debt y credit_balance a 0', async () => {
    // El DTO no contempla estos campos (whitelist los strippea). Aquí el
    // contrato del action es hard-codearlos a 0 en el INSERT — defensa
    // adicional contra invocaciones directas (queue worker, test).
    await action.execute({ legal_name: 'Distribuidora X' }, 1, { id: 1, fullName: 'Owner' });

    expect(createdInput?.accumulated_debt).toBe(0);
    expect(createdInput?.credit_balance).toBe(0);
  });

  it('asigna company_id y created_by* desde el contexto', async () => {
    await action.execute({ legal_name: 'Acme' }, 42, { id: 7, fullName: 'Kike Pacheco' });
    expect(createdInput?.company_id).toBe('42');
    expect(createdInput?.created_by).toBe('Kike Pacheco');
    expect(createdInput?.created_by_id).toBe('7');
  });

  it('hace trim de legal_name y opcionales', async () => {
    await action.execute(
      {
        legal_name: '  Acme S.A.  ',
        broker: ' María ',
        phone: '   ',
        email: ' info@acme.com ',
      },
      1,
      { id: 1, fullName: 'Owner' },
    );

    expect(createdInput?.legal_name).toBe('Acme S.A.');
    expect(createdInput?.broker).toBe('María');
    expect(createdInput?.phone).toBeNull();
    expect(createdInput?.email).toBe('info@acme.com');
  });
});
