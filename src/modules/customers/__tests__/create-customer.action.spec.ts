import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CreateCustomerAction } from '../actions/create-customer.action';
import type { Customer } from '../entities/customer.entity';
import { PersonType } from '../entities/customer.entity';

/**
 * Tests unitarios del action `CreateCustomerAction`.
 *
 * Enfoque (CLAUDE.md §2.2 y §8): garantizar que
 *   - `company_id`, `created_by`, `created_by_id` se asignan desde el contexto,
 *     NUNCA del DTO.
 *   - `balance` se inicializa a 0 ignorando lo que el DTO traiga (defensa
 *     adicional al strippe del ValidationPipe).
 *   - `is_archived` arranca false.
 *
 * No probamos `dataSource.transaction` real — mockeamos para que el callback
 * corra contra un `manager` simulado.
 */
describe('CreateCustomerAction', () => {
  let action: CreateCustomerAction;
  let savedCustomer: Customer | null;
  let createdInput: Partial<Customer> | null;

  beforeEach(async () => {
    savedCustomer = null;
    createdInput = null;

    const managerMock = {
      create: jest.fn((_entity: unknown, input: Partial<Customer>) => {
        createdInput = input;
        return input as Customer;
      }),
      save: jest.fn((_entity: unknown, customer: Customer): Promise<Customer> => {
        // Simula INSERT: completa id y created_at; preserva todos los campos.
        savedCustomer = {
          ...customer,
          id: '1',
          created_at: new Date('2026-05-12T14:30:00.000Z'),
          updated_at: new Date('2026-05-12T14:30:00.000Z'),
        };
        return Promise.resolve(savedCustomer);
      }),
    };

    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CreateCustomerAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(CreateCustomerAction);
  });

  it('asigna company_id desde el parámetro, no del DTO', async () => {
    // El DTO ni siquiera contempla company_id (whitelist). Como `CreateCustomerDto`
    // no tiene `company_id`, no podemos contaminarlo con TypeScript estricto;
    // testeamos el flujo "feliz" para asegurar que el valor proviene del
    // parámetro `companyId`. La protección anti-payload contaminado vive en
    // el ValidationPipe global (whitelist + forbidNonWhitelisted) y se cubre
    // por e2e.
    await action.execute({ name: 'Juan' }, 42, { id: 7, fullName: 'Kike' });

    expect(createdInput?.company_id).toBe('42');
    expect(savedCustomer?.company_id).toBe('42');
  });

  it('inicializa balance a 0 e is_archived a false', async () => {
    // Aunque el DTO no contemple balance/is_archived, el action debe
    // hard-codearlos en el INSERT como defensa adicional.
    await action.execute({ name: 'María' }, 1, { id: 1, fullName: 'Owner' });

    expect(createdInput?.balance).toBe(0);
    expect(createdInput?.is_archived).toBe(false);
  });

  it('persiste person_type default INDIVIDUAL si no viene', async () => {
    await action.execute({ name: 'Pedro' }, 1, { id: 1, fullName: 'Owner' });
    expect(createdInput?.person_type).toBe(PersonType.INDIVIDUAL);
  });

  it('respeta person_type COMPANY cuando viene', async () => {
    await action.execute({ name: 'Acme S.A.', person_type: PersonType.COMPANY }, 1, {
      id: 1,
      fullName: 'Owner',
    });
    expect(createdInput?.person_type).toBe(PersonType.COMPANY);
  });

  it('hace trim de los campos de texto', async () => {
    await action.execute(
      {
        name: '  Juan Pérez  ',
        email: '  juan@ejemplo.com ',
        phone: '  ',
        doc_number: ' V-12345678 ',
        address: '',
      },
      1,
      { id: 1, fullName: 'Owner' },
    );

    expect(createdInput?.name).toBe('Juan Pérez');
    expect(createdInput?.email).toBe('juan@ejemplo.com');
    // String en blanco ⇒ null (paridad PlacePos).
    expect(createdInput?.phone).toBeNull();
    expect(createdInput?.doc_number).toBe('V-12345678');
    expect(createdInput?.address).toBeNull();
  });

  it('congela created_by/created_by_id desde el actor', async () => {
    await action.execute({ name: 'X' }, 1, { id: 17, fullName: 'Kike Pacheco' });
    expect(createdInput?.created_by).toBe('Kike Pacheco');
    expect(createdInput?.created_by_id).toBe('17');
  });
});
